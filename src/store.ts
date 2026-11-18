// Persistence. `SqliteStore` (./sqlite-store.ts, a local file) is the default. `SupabaseStore` is
// optional: it talks to the three mesh_* tables of a Supabase project (public schema, RLS on,
// service-role only; DDL in supabase/migrations). `MemoryStore` is for tests and throwaway runs.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SqliteStore } from "./sqlite-store.js";
import { handleTaken, xUserIdTaken } from "./store-shared.js";

export { SqliteStore };
export { StoreError, type StoreErrorCode } from "./store-shared.js";

export type ThreadStatus = "proposed" | "active" | "input_required" | "completed" | "declined" | "canceled";
export type MessageKind = "proposal" | "accept" | "decline" | "update" | "escalation" | "payment_draft" | "status";

export interface Agent {
  id: string;
  x_user_id: string;
  x_handle: string;
  agent_card_url: string | null;
  display_name: string | null;
  owner_opt_in: boolean;
  opted_in_at: string | null;
  x_verified: boolean;
  api_key_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface Thread {
  id: string;
  goal: string;
  proposer_x_user_id: string;
  participants: string[];
  accepted_by: string[];
  status: ThreadStatus;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: string;
  thread_id: string;
  from_x_user_id: string;
  kind: MessageKind;
  /** An A2A Message object. */
  message: Record<string, unknown>;
  needs_human: boolean;
  created_at: string;
}

export type NewAgent = Pick<Agent, "x_user_id" | "x_handle" | "agent_card_url" | "display_name" | "owner_opt_in" | "opted_in_at" | "api_key_hash">;
/** `x_verified` is set only by the X OAuth callback (src/xauth.ts) and cleared when a verified agent changes its handle. */
export type AgentPatch = Partial<Pick<Agent, "x_handle" | "agent_card_url" | "display_name" | "owner_opt_in" | "opted_in_at" | "api_key_hash" | "x_verified">>;
export type NewThread = Pick<Thread, "goal" | "proposer_x_user_id" | "participants" | "accepted_by" | "status">;
export type ThreadPatch = Partial<Pick<Thread, "accepted_by" | "status">>;
export type NewMessage = Pick<StoredMessage, "thread_id" | "from_x_user_id" | "kind" | "message" | "needs_human"> & { id?: string };

export interface Store {
  readonly kind: "supabase" | "sqlite" | "memory";
  getAgentByXUserId(xUserId: string): Promise<Agent | null>;
  /** Case-insensitive. */
  getAgentByHandle(handle: string): Promise<Agent | null>;
  getAgentByKeyHash(hash: string): Promise<Agent | null>;
  /** The opted-in agents among `xUserIds` (never a non-opted-in one). */
  getOptedInAgents(xUserIds: string[]): Promise<Agent[]>;
  /**
   * Check and write are one step: of two concurrent calls for one handle (any case) or one
   * x_user_id, exactly one succeeds and the other gets a StoreError (`handle_taken` / `x_user_id_taken`).
   */
  insertAgent(a: NewAgent): Promise<Agent>;
  /** A patch that sets `x_handle` to one another agent holds (any case) gets StoreError `handle_taken`. */
  updateAgent(xUserId: string, patch: AgentPatch): Promise<Agent>;
  insertThread(t: NewThread): Promise<Thread>;
  getThread(id: string): Promise<Thread | null>;
  /**
   * Compare-and-set: applies `patch` only if the thread's `updated_at` is still `ifUpdatedAt`.
   * Returns null when someone else changed the thread in between (re-read and retry).
   */
  updateThread(id: string, patch: ThreadPatch, ifUpdatedAt: string): Promise<Thread | null>;
  /** Threads `xUserId` participates in, most recently updated first (at most 100). */
  listThreadsFor(xUserId: string, status?: ThreadStatus): Promise<Thread[]>;
  insertMessage(m: NewMessage): Promise<StoredMessage>;
  /** The latest `limit` messages of a thread, oldest first. */
  listMessages(threadId: string, limit: number): Promise<StoredMessage[]>;
}

// ---- memory ----

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private agents = new Map<string, Agent>(); // by x_user_id
  private threads = new Map<string, Thread>();
  private messages: StoredMessage[] = [];
  private last = 0;

  /** Strictly increasing timestamps, so compare-and-set and ordering behave as they do in Postgres. */
  private stamp(): string {
    this.last = Math.max(Date.now(), this.last + 1);
    return new Date(this.last).toISOString();
  }

  async getAgentByXUserId(xUserId: string) {
    return clone(this.agents.get(xUserId) ?? null);
  }
  async getAgentByHandle(handle: string) {
    const h = handle.toLowerCase();
    for (const a of this.agents.values()) if (a.x_handle.toLowerCase() === h) return clone(a);
    return null;
  }
  async getAgentByKeyHash(hash: string) {
    for (const a of this.agents.values()) if (a.api_key_hash === hash) return clone(a);
    return null;
  }
  async getOptedInAgents(xUserIds: string[]) {
    const out: Agent[] = [];
    for (const id of new Set(xUserIds)) {
      const a = this.agents.get(id);
      if (a?.owner_opt_in) out.push(clone(a));
    }
    return out;
  }
  async insertAgent(a: NewAgent) {
    if (this.agents.has(a.x_user_id)) throw xUserIdTaken();
    this.checkHandleFree(a.x_handle, a.x_user_id);
    const at = this.stamp();
    const row: Agent = { id: randomUUID(), x_verified: false, created_at: at, updated_at: at, ...a };
    this.agents.set(row.x_user_id, row);
    return clone(row);
  }
  async updateAgent(xUserId: string, patch: AgentPatch) {
    const row = this.agents.get(xUserId);
    if (!row) throw new Error("agent not found");
    if (patch.x_handle !== undefined) this.checkHandleFree(patch.x_handle, xUserId);
    Object.assign(row, patch, { updated_at: this.stamp() });
    return clone(row);
  }
  /** No await between this check and the write that follows it, so nothing can interleave. */
  private checkHandleFree(handle: string, xUserId: string): void {
    const h = handle.toLowerCase();
    for (const a of this.agents.values()) if (a.x_user_id !== xUserId && a.x_handle.toLowerCase() === h) throw handleTaken();
  }
  async insertThread(t: NewThread) {
    const at = this.stamp();
    const row: Thread = { id: randomUUID(), created_at: at, updated_at: at, ...clone(t) };
    this.threads.set(row.id, row);
    return clone(row);
  }
  async getThread(id: string) {
    return clone(this.threads.get(id) ?? null);
  }
  async updateThread(id: string, patch: ThreadPatch, ifUpdatedAt: string) {
    const row = this.threads.get(id);
    if (!row || row.updated_at !== ifUpdatedAt) return null;
    Object.assign(row, clone(patch), { updated_at: this.stamp() });
    return clone(row);
  }
  async listThreadsFor(xUserId: string, status?: ThreadStatus) {
    return [...this.threads.values()]
      .filter((t) => t.participants.includes(xUserId) && (!status || t.status === status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 100)
      .map((t) => clone(t));
  }
  async insertMessage(m: NewMessage) {
    const row: StoredMessage = { ...clone(m), id: m.id ?? randomUUID(), created_at: this.stamp() };
    this.messages.push(row);
    return clone(row);
  }
  async listMessages(threadId: string, limit: number) {
    return this.messages.filter((m) => m.thread_id === threadId).slice(-limit).map((m) => clone(m));
  }
}

function clone<T>(v: T): T {
  return v === null || v === undefined ? v : (structuredClone(v) as T);
}

// ---- supabase ----

/** `.in()` filters travel in the URL: ask for this many ids per request. */
const IN_CHUNK = 200;

export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;
  constructor(private db: SupabaseClient) {}

  async getAgentByXUserId(xUserId: string) {
    return one<Agent>(await this.db.from("mesh_agents").select("*").eq("x_user_id", xUserId).maybeSingle());
  }
  async getAgentByHandle(handle: string) {
    // `_` is a LIKE wildcard and is legal in X handles: escape it, then compare exactly.
    const pattern = handle.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = many<Agent>(await this.db.from("mesh_agents").select("*").ilike("x_handle", pattern).limit(5));
    return rows.find((a) => a.x_handle.toLowerCase() === handle.toLowerCase()) ?? null;
  }
  async getAgentByKeyHash(hash: string) {
    return one<Agent>(await this.db.from("mesh_agents").select("*").eq("api_key_hash", hash).maybeSingle());
  }
  async getOptedInAgents(xUserIds: string[]) {
    const ids = [...new Set(xUserIds)];
    const out: Agent[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      out.push(...many<Agent>(await this.db.from("mesh_agents").select("*").in("x_user_id", chunk).eq("owner_opt_in", true)));
    }
    return out;
  }
  async insertAgent(a: NewAgent) {
    return must<Agent>(await this.db.from("mesh_agents").insert(a).select("*").single());
  }
  async updateAgent(xUserId: string, patch: AgentPatch) {
    return must<Agent>(
      await this.db.from("mesh_agents").update({ ...patch, updated_at: new Date().toISOString() }).eq("x_user_id", xUserId).select("*").single(),
    );
  }
  async insertThread(t: NewThread) {
    return must<Thread>(await this.db.from("mesh_threads").insert(t).select("*").single());
  }
  async getThread(id: string) {
    return one<Thread>(await this.db.from("mesh_threads").select("*").eq("id", id).maybeSingle());
  }
  async updateThread(id: string, patch: ThreadPatch, ifUpdatedAt: string) {
    return one<Thread>(
      await this.db
        .from("mesh_threads")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("updated_at", ifUpdatedAt)
        .select("*")
        .maybeSingle(),
    );
  }
  async listThreadsFor(xUserId: string, status?: ThreadStatus) {
    let q = this.db.from("mesh_threads").select("*").contains("participants", [xUserId]);
    if (status) q = q.eq("status", status);
    return many<Thread>(await q.order("updated_at", { ascending: false }).limit(100));
  }
  async insertMessage(m: NewMessage) {
    return must<StoredMessage>(await this.db.from("mesh_messages").insert(m).select("*").single());
  }
  async listMessages(threadId: string, limit: number) {
    const rows = many<StoredMessage>(
      await this.db.from("mesh_messages").select("*").eq("thread_id", threadId).order("created_at", { ascending: false }).limit(limit),
    );
    return rows.reverse();
  }
}

interface DbResult {
  data: unknown;
  error: { message: string; code?: string; details?: string } | null;
}
/**
 * Database errors are logged for the operator; callers only learn that the store failed. The one
 * exception is a unique violation on mesh_agents (Postgres 23505): the race-safe answer to two
 * registrations of one handle or one x_user_id.
 */
function check(r: DbResult): unknown {
  if (r.error) {
    if (r.error.code === "23505") {
      const what = `${r.error.message} ${r.error.details ?? ""}`;
      if (/handle/i.test(what)) throw handleTaken();
      if (/x_user_id/i.test(what)) throw xUserIdTaken();
    }
    console.error(`[x-agent-mesh] supabase error: ${r.error.message}`);
    throw new Error("The mesh database is unavailable or rejected the request.");
  }
  return r.data;
}
const one = <T>(r: DbResult) => (check(r) as T | null) ?? null;
const many = <T>(r: DbResult) => (check(r) as T[] | null) ?? [];
function must<T>(r: DbResult): T {
  const v = check(r) as T | null;
  if (v === null || v === undefined) throw new Error("The mesh database returned no row.");
  return v;
}

export const DEFAULT_SQLITE_PATH = "./data/mesh.db";

/**
 * Picks the store from the environment, and logs which (to stderr: stdout belongs to the stdio transport):
 * 1. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY both set: SupabaseStore.
 * 2. MESH_STORE=memory: MemoryStore (lost on restart).
 * 3. Otherwise: SqliteStore at MESH_SQLITE_PATH (default ./data/mesh.db; the directory is created).
 */
export function createStore(env: NodeJS.ProcessEnv = process.env): Store {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    console.error(`[x-agent-mesh] store: Supabase (${new URL(url).host})`);
    return new SupabaseStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
  }
  if (url || key) console.error("[x-agent-mesh] only one of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is set: ignoring it.");
  if (env.MESH_STORE?.trim().toLowerCase() === "memory") {
    console.error("[x-agent-mesh] store: in-memory (MESH_STORE=memory). Data is lost on restart.");
    return new MemoryStore();
  }
  const store = new SqliteStore(env.MESH_SQLITE_PATH?.trim() || DEFAULT_SQLITE_PATH);
  console.error(`[x-agent-mesh] store: SQLite (${store.path})`);
  return store;
}
