// SQLite persistence (the default store), on Node's built-in `node:sqlite`: no npm dependency.
// Same three tables as the Supabase DDL in supabase/migrations, translated: uuids and timestamps
// are TEXT (ISO 8601, UTC), booleans are 0/1, arrays and the A2A message are JSON text.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Agent, AgentPatch, NewAgent, NewMessage, NewThread, Store, StoredMessage, Thread, ThreadPatch, ThreadStatus } from "./store.js";
import { handleTaken, MESSAGE_OVERHEAD_BYTES, quotaExceeded, StoreError, THREAD_OVERHEAD_BYTES, xUserIdTaken, type WriteOptions } from "./store-shared.js";

const SCHEMA = `
create table if not exists mesh_agents (
  id text primary key,
  x_user_id text not null unique,
  x_handle text not null,
  agent_card_url text,
  display_name text,
  owner_opt_in integer not null default 0 check (owner_opt_in in (0, 1)),
  opted_in_at text,
  x_verified integer not null default 0 check (x_verified in (0, 1)),
  api_key_hash text,
  created_at text not null,
  updated_at text not null
);
create index if not exists mesh_agents_handle_idx on mesh_agents (lower(x_handle));
create index if not exists mesh_agents_api_key_hash_idx on mesh_agents (api_key_hash);
create table if not exists mesh_threads (
  id text primary key,
  goal text not null check (length(goal) between 1 and 2000),
  proposer_x_user_id text not null references mesh_agents(x_user_id) on delete cascade,
  participants text not null check (json_valid(participants)),
  accepted_by text not null default '[]' check (json_valid(accepted_by)),
  status text not null default 'proposed' check (status in ('proposed','active','input_required','completed','declined','canceled')),
  created_at text not null,
  updated_at text not null
);
create index if not exists mesh_threads_updated_idx on mesh_threads (updated_at);
create table if not exists mesh_messages (
  id text primary key,
  thread_id text not null references mesh_threads(id) on delete cascade,
  from_x_user_id text not null,
  kind text not null default 'update' check (kind in ('proposal','accept','decline','update','escalation','payment_draft','status')),
  message text not null check (json_valid(message)),
  needs_human integer not null default 0 check (needs_human in (0, 1)),
  created_at text not null
);
create index if not exists mesh_messages_thread_idx on mesh_messages (thread_id, created_at);
`;

/**
 * Added after the first release. Everything here is additive (new tables and indexes, `if not
 * exists`), so a database made by an earlier version gains it on the next start, and an earlier
 * version of the server can still open the file afterwards: it simply ignores what it does not know.
 *
 * mesh_thread_participants: one row per (participant, thread), so "my threads" is an index lookup
 * instead of a scan of every thread's JSON participant list. A thread's participants never change
 * after it is created, so the rows are written once, with the thread.
 *
 * mesh_meta: a few named values the store keeps for itself (see "stored_bytes" below).
 */
const SCHEMA_ADDITIONS = `
create table if not exists mesh_thread_participants (
  x_user_id text not null,
  thread_id text not null references mesh_threads(id) on delete cascade,
  primary key (x_user_id, thread_id)
) without rowid;
create index if not exists mesh_thread_participants_thread_idx on mesh_thread_participants (thread_id);
create table if not exists mesh_meta (
  key text primary key,
  value text not null
) without rowid;
`;

type CountedTable = "mesh_threads" | "mesh_messages";
/** mesh_meta keys: the highest rowid of each table whose rows are included in mesh_agents.stored_bytes. */
const MARK: Record<CountedTable, string> = { mesh_threads: "usage_counted_threads_rowid", mesh_messages: "usage_counted_messages_rowid" };

export interface UsageSummary {
  /** What start-up had to read: nothing, only rows added since the last count, or every row. */
  mode: "none" | "delta" | "full";
  /** Agents whose counter was changed. */
  corrected: number;
  agents: number;
  totalBytes: number;
  largestBytes: number;
}

/** The size of a row as store-shared.ts defines it (threadBytes / messageBytes), computed by SQLite from what it stored. */
const THREAD_BYTES_SQL = `(octet_length(goal) + octet_length(participants) + ${THREAD_OVERHEAD_BYTES})`;
const MESSAGE_BYTES_SQL = `(octet_length(message) + ${MESSAGE_OVERHEAD_BYTES})`;

/** One agent per handle, whatever its case. Created at start-up only when the existing rows allow it. */
const HANDLE_UNIQUE_INDEX = "mesh_agents_handle_uniq";

type Row = Record<string, unknown>;

/** A database failure that was already logged and reworded: passed up as it is. */
class Unavailable extends Error {}

/**
 * Loads `node:sqlite` on first use, so that a server on another store never touches it, and keeps
 * its "SQLite is an experimental feature" warning (Node 22 / 23) off stderr. Other warnings pass.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    const first = rest[0];
    const type = typeof first === "string" ? first : ((first as { type?: string } | undefined)?.type ?? (warning as Error).name);
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = typeof process.getBuiltinModule === "function" ? process.getBuiltinModule("node:sqlite") : undefined;
    if (!mod?.DatabaseSync) {
      throw new Error(`The SQLite store needs Node >= 22.5 (built-in node:sqlite); this is ${process.version}. Upgrade Node, or set MESH_STORE=memory.`);
    }
    return mod;
  } finally {
    process.emitWarning = original;
  }
}

export class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  /** The resolved file path, or ":memory:". */
  readonly path: string;
  private db: DatabaseSync;
  private last = 0;
  /**
   * Whether the unique index on lower(x_handle) exists. False only when the file already held two
   * agents with one handle: the server still starts, and writes are still checked in a transaction.
   */
  handlesUnique = false;

  /** Opens (creating the file, its directory and the schema as needed) the database at `path`; ":memory:" for a private one. */
  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("pragma journal_mode = WAL; pragma foreign_keys = ON; pragma busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.db.exec(SCHEMA_ADDITIONS);
    this.ensureHandleIndex();
    this.backfillParticipants();
    const columnAdded = this.ensureUsageColumn();
    this.usageAtStart = this.syncUsage(columnAdded);
  }

  /** What the usage counters looked like when the store was opened, and what bringing them up to date took (for the start-up log). */
  readonly usageAtStart: UsageSummary;

  /**
   * Adds mesh_agents.stored_bytes to a database made by an earlier version. A plain ADD COLUMN with
   * a default: existing rows are not rewritten, and an earlier version of the server can still use
   * the file (it names its columns when it inserts, and ignores this one when it reads).
   * Returns whether the column had to be added.
   */
  private ensureUsageColumn(): boolean {
    return this.tx(() => {
      if (this.all("pragma table_info(mesh_agents)").some((c) => c.name === "stored_bytes")) return false;
      this.db.exec("alter table mesh_agents add column stored_bytes integer not null default 0");
      return true;
    });
  }

  // ---- stored_bytes: keeping the counters equal to the tables ----
  //
  // Each insert adds the row's size to its author's counter in the same transaction. What remains
  // is rows this version did not insert: everything, on a database from an earlier version, and
  // whatever an earlier version writes if the file is ever rolled back to it. Reading all of a
  // large messages table at every start would cost seconds per gigabyte, so mesh_meta holds two
  // marks: the highest rowid of mesh_threads and of mesh_messages whose rows are in the counters.
  // Rows are never deleted and SQLite hands out rowids in increasing order, so "not counted yet"
  // is exactly "rowid above the mark". At start: no marks → count everything; marks behind → count
  // only the rows above them; marks at the top (the normal case) → nothing to read.

  private maxRowid(table: CountedTable): number {
    return Number(this.must(`select coalesce(max(rowid), 0) as r from ${table}`).r);
  }

  private marks(): Record<CountedTable, number> | null {
    const rows = this.all("select key, value from mesh_meta where key in (?, ?)", MARK.mesh_threads, MARK.mesh_messages);
    const of = (table: CountedTable): number | null => {
      const v = rows.find((r) => r.key === MARK[table])?.value;
      return typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : null;
    };
    const threads = of("mesh_threads");
    const messages = of("mesh_messages");
    return threads === null || messages === null ? null : { mesh_threads: threads, mesh_messages: messages };
  }

  private setMarks(at: Record<CountedTable, number>): void {
    const put = this.db.prepare("insert into mesh_meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value");
    for (const table of ["mesh_threads", "mesh_messages"] as const) this.run(() => put.run(MARK[table], String(at[table])));
  }

  /** Bytes per author over the rows above the given rowids (0, 0 = every row). */
  private bytesByAuthor(above: Record<CountedTable, number>): Map<string, number> {
    const out = new Map<string, number>();
    const add = (rows: Row[]) => {
      for (const r of rows) out.set(String(r.u), (out.get(String(r.u)) ?? 0) + Number(r.b));
    };
    add(this.all(`select proposer_x_user_id as u, sum(${THREAD_BYTES_SQL}) as b from mesh_threads where rowid > ? group by proposer_x_user_id`, above.mesh_threads));
    add(this.all(`select from_x_user_id as u, sum(${MESSAGE_BYTES_SQL}) as b from mesh_messages where rowid > ? group by from_x_user_id`, above.mesh_messages));
    return out;
  }

  /** Sets every counter to what the tables hold. Only rows whose number is wrong are written. Returns how many were. Inside a transaction. */
  private recount(): number {
    const actual = this.bytesByAuthor({ mesh_threads: 0, mesh_messages: 0 });
    const fix = this.db.prepare("update mesh_agents set stored_bytes = ? where x_user_id = ?");
    let corrected = 0;
    for (const a of this.all("select x_user_id, stored_bytes from mesh_agents")) {
      const want = actual.get(String(a.x_user_id)) ?? 0;
      if (Number(a.stored_bytes) === want) continue;
      this.run(() => fix.run(want, String(a.x_user_id)));
      corrected++;
    }
    return corrected;
  }

  private summary(mode: UsageSummary["mode"], corrected: number): UsageSummary {
    const r = this.must("select count(*) as n, coalesce(sum(stored_bytes), 0) as total, coalesce(max(stored_bytes), 0) as largest from mesh_agents");
    return { mode, corrected, agents: Number(r.n), totalBytes: Number(r.total), largestBytes: Number(r.largest) };
  }

  /** Brings the counters up to date at start-up, reading as little as the marks allow (see above). */
  private syncUsage(forceFull: boolean): UsageSummary {
    const out = this.tx(() => {
      const marks = forceFull ? null : this.marks();
      const top = { mesh_threads: this.maxRowid("mesh_threads"), mesh_messages: this.maxRowid("mesh_messages") };
      let mode: UsageSummary["mode"] = "none";
      let corrected = 0;
      if (!marks || marks.mesh_threads > top.mesh_threads || marks.mesh_messages > top.mesh_messages) {
        // Never counted, or rows the marks speak of are gone (someone edited the file): start over.
        mode = "full";
        corrected = this.recount();
      } else if (marks.mesh_threads < top.mesh_threads || marks.mesh_messages < top.mesh_messages) {
        mode = "delta";
        const add = this.db.prepare("update mesh_agents set stored_bytes = stored_bytes + ? where x_user_id = ?");
        for (const [author, bytes] of this.bytesByAuthor(marks)) corrected += Number(this.run(() => add.run(bytes, author)).changes);
      }
      this.setMarks(top);
      return this.summary(mode, corrected);
    });
    if (out.corrected > 0) {
      console.error(`[x-agent-mesh] sqlite: recomputed stored_bytes for ${out.corrected} of ${out.agents} agents from ${out.mode === "full" ? "the tables" : "the rows added since the last count"}.`);
    }
    return out;
  }

  /**
   * Sets every agent's stored_bytes to what the tables actually hold, reading all of them: for an
   * operator who edited the database by hand (deleting rows does not move the marks, so start-up
   * would not notice). Deleting the rows of mesh_meta and restarting does the same.
   */
  recomputeUsage(): UsageSummary {
    return this.tx(() => {
      const corrected = this.recount();
      this.setMarks({ mesh_threads: this.maxRowid("mesh_threads"), mesh_messages: this.maxRowid("mesh_messages") });
      return this.summary("full", corrected);
    });
  }

  /**
   * Adds the size of the row just inserted (computed by SQLite from what it stored) to its
   * author's counter, refusing first if that would pass the limit, and moves the table's mark up
   * to the row. Call inside the insert's transaction.
   */
  private count(author: string, table: CountedTable, id: string, opts?: WriteOptions): void {
    const row = this.must(`select rowid as r, ${table === "mesh_threads" ? THREAD_BYTES_SQL : MESSAGE_BYTES_SQL} as b from ${table} where id = ?`, id);
    const rowid = Number(row.r);
    const bytes = Number(row.b);
    if (opts?.limitBytes !== undefined) {
      const used = Number(this.get("select stored_bytes from mesh_agents where x_user_id = ?", author)?.stored_bytes ?? 0);
      // Thrown inside the transaction: the row just inserted is rolled back with it.
      if (used + bytes > opts.limitBytes) throw quotaExceeded(used, bytes, opts.limitBytes);
    }
    this.run(() => this.db.prepare("update mesh_agents set stored_bytes = stored_bytes + ? where x_user_id = ?").run(bytes, author));
    // The mark moves only from the row directly below this one: then every row up to here is
    // counted. If it is anywhere else, some row in between was written without being counted (an
    // earlier version of the server using the file at the same time): the marks can no longer be
    // trusted, so they are dropped and the next start counts everything again.
    const below = Number(this.get(`select rowid as r from ${table} where rowid < ? order by rowid desc limit 1`, rowid)?.r ?? 0);
    const moved = this.run(() => this.db.prepare("update mesh_meta set value = ? where key = ? and value = ?").run(String(rowid), MARK[table], String(below)));
    if (Number(moved.changes) === 0) this.run(() => this.db.prepare("delete from mesh_meta where key in (?, ?)").run(MARK.mesh_threads, MARK.mesh_messages));
  }

  /**
   * Gives every thread that has no participant rows its rows, from the thread's own JSON list.
   * Runs at every start: it is a no-op once done (threads that already have rows are skipped by an
   * index probe, and `insert or ignore` cannot duplicate), and it also picks up threads written by
   * an earlier version of the server, should the file ever be opened by one in between.
   * Returns how many rows were added.
   */
  private backfillParticipants(): number {
    const added = this.tx(() => {
      const r = this.db
        .prepare(
          // The list of threads to do is fixed (materialized) before the first row goes in, so a
          // thread's first participant row cannot make the statement skip its other participants.
          `with todo as materialized (
             select t.id, t.participants from mesh_threads t
             where not exists (select 1 from mesh_thread_participants p where p.thread_id = t.id)
           )
           insert or ignore into mesh_thread_participants (x_user_id, thread_id)
           select j.value, todo.id from todo, json_each(todo.participants) j where j.type = 'text'`,
        )
        .run();
      return Number(r.changes);
    });
    if (added > 0) console.error(`[x-agent-mesh] sqlite: indexed ${added} thread participant rows (mesh_thread_participants backfill).`);
    return added;
  }

  /**
   * Adds the unique index on lower(x_handle) to a database made by an earlier version. Never fails
   * start-up and never touches a row: if two agents already share a handle the index is skipped
   * with a warning, and tried again on the next start.
   */
  private ensureHandleIndex(): void {
    try {
      this.tx(() => {
        const dups = this.all("select lower(x_handle) as handle, count(*) as n from mesh_agents group by lower(x_handle) having count(*) > 1 order by 1 limit 5");
        if (dups.length > 0) {
          const shown = dups.map((d) => `@${String(d.handle)} (${String(d.n)} agents)`).join(", ");
          console.error(
            `[x-agent-mesh] WARNING: handles registered more than once: ${shown}${dups.length === 5 ? ", ..." : ""}. The unique index ${HANDLE_UNIQUE_INDEX} was NOT created and no row was changed. New duplicates are still refused. Resolve these by hand, then restart.`,
          );
          return;
        }
        this.db.exec(`create unique index if not exists ${HANDLE_UNIQUE_INDEX} on mesh_agents (lower(x_handle))`);
        this.handlesUnique = true;
      });
    } catch {
      console.error(`[x-agent-mesh] WARNING: could not create the unique index ${HANDLE_UNIQUE_INDEX}; continuing without it.`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Strictly increasing within this process, and always later than `after` (a row's current stamp). */
  private stamp(after?: string): string {
    const floor = after ? Date.parse(after) + 1 : 0;
    this.last = Math.max(Date.now(), this.last + 1, Number.isFinite(floor) ? floor : 0);
    return new Date(this.last).toISOString();
  }

  /** Database errors are logged for the operator; callers only learn that the store failed. */
  private run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof StoreError || e instanceof Unavailable) throw e;
      const text = e instanceof Error ? e.message : String(e);
      // The unique indexes are the last line of defence behind the checks in insertAgent / updateAgent.
      if (/UNIQUE constraint failed/i.test(text)) {
        if (text.includes(HANDLE_UNIQUE_INDEX)) throw handleTaken();
        if (text.includes("mesh_agents.x_user_id")) throw xUserIdTaken();
      }
      console.error(`[x-agent-mesh] sqlite error: ${text}`);
      throw new Unavailable("The mesh database is unavailable or rejected the request.");
    }
  }
  /**
   * Runs `fn` in one write transaction. BEGIN IMMEDIATE takes the write lock up front, so a check
   * followed by a write cannot interleave with another connection to the same file.
   */
  private tx<T>(fn: () => T): T {
    return this.run(() => {
      this.db.exec("begin immediate");
      try {
        const out = fn();
        this.db.exec("commit");
        return out;
      } catch (e) {
        try {
          this.db.exec("rollback");
        } catch {
          /* the failed statement already ended the transaction */
        }
        throw e;
      }
    });
  }
  /** Throws when another agent holds `handle` (compared without case). */
  private checkHandleFree(handle: string, xUserId: string): void {
    if (this.get("select 1 from mesh_agents where lower(x_handle) = lower(?) and x_user_id <> ? limit 1", handle, xUserId)) throw handleTaken();
  }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.run(() => this.db.prepare(sql).get(...params) as Row | undefined);
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.run(() => this.db.prepare(sql).all(...params) as Row[]);
  }
  private must(sql: string, ...params: SQLInputValue[]): Row {
    const row = this.get(sql, ...params);
    if (!row) throw new Error("The mesh database returned no row.");
    return row;
  }

  async getAgentByXUserId(xUserId: string) {
    return agent(this.get("select * from mesh_agents where x_user_id = ?", xUserId));
  }
  async getAgentByHandle(handle: string) {
    return agent(this.get("select * from mesh_agents where lower(x_handle) = lower(?) order by rowid limit 1", handle));
  }
  async getAgentByKeyHash(hash: string) {
    return agent(this.get("select * from mesh_agents where api_key_hash = ?", hash));
  }
  async getOptedInAgents(xUserIds: string[]) {
    if (xUserIds.length === 0) return [];
    const ids = JSON.stringify([...new Set(xUserIds)]);
    return this.all("select * from mesh_agents where owner_opt_in = 1 and x_user_id in (select value from json_each(?))", ids).map((r) => agent(r)!);
  }
  async insertAgent(a: NewAgent) {
    return this.tx(() => {
      if (this.get("select 1 from mesh_agents where x_user_id = ?", a.x_user_id)) throw xUserIdTaken();
      this.checkHandleFree(a.x_handle, a.x_user_id);
      const at = this.stamp();
      return agent(
        this.must(
          `insert into mesh_agents (id, x_user_id, x_handle, agent_card_url, display_name, owner_opt_in, opted_in_at, api_key_hash, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning *`,
          randomUUID(), a.x_user_id, a.x_handle, a.agent_card_url, a.display_name, a.owner_opt_in ? 1 : 0, a.opted_in_at, a.api_key_hash, at, at,
        ),
      )!;
    });
  }
  async updateAgent(xUserId: string, patch: AgentPatch) {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const col of ["x_handle", "agent_card_url", "display_name", "owner_opt_in", "opted_in_at", "api_key_hash", "x_verified"] as const) {
      const v = patch[col];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
    return this.tx(() => {
      if (patch.x_handle !== undefined) this.checkHandleFree(patch.x_handle, xUserId);
      const current = this.get("select updated_at from mesh_agents where x_user_id = ?", xUserId);
      sets.push("updated_at = ?");
      params.push(this.stamp(current?.updated_at as string | undefined));
      return agent(this.must(`update mesh_agents set ${sets.join(", ")} where x_user_id = ? returning *`, ...params, xUserId))!;
    });
  }
  async insertThread(t: NewThread, opts?: WriteOptions) {
    return this.tx(() => {
      const at = this.stamp();
      const row = thread(
        this.must(
          `insert into mesh_threads (id, goal, proposer_x_user_id, participants, accepted_by, status, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?) returning *`,
          randomUUID(), t.goal, t.proposer_x_user_id, JSON.stringify(t.participants), JSON.stringify(t.accepted_by), t.status, at, at,
        ),
      )!;
      const add = this.db.prepare("insert or ignore into mesh_thread_participants (x_user_id, thread_id) values (?, ?)");
      for (const p of new Set(row.participants)) if (typeof p === "string") add.run(p, row.id);
      this.count(row.proposer_x_user_id, "mesh_threads", row.id, opts);
      return row;
    });
  }
  async getThread(id: string) {
    return thread(this.get("select * from mesh_threads where id = ?", id));
  }
  async updateThread(id: string, patch: ThreadPatch, ifUpdatedAt: string) {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.accepted_by !== undefined) {
      sets.push("accepted_by = ?");
      params.push(JSON.stringify(patch.accepted_by));
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    // The new stamp is always later than the one compared against, so a writer holding the old
    // value can never match again, whichever process wrote. The UPDATE itself is atomic.
    sets.push("updated_at = ?");
    params.push(this.stamp(ifUpdatedAt));
    return thread(this.get(`update mesh_threads set ${sets.join(", ")} where id = ? and updated_at = ? returning *`, ...params, id, ifUpdatedAt));
  }
  async listThreadsFor(xUserId: string, status?: ThreadStatus) {
    // CROSS JOIN fixes the join order: this agent's rows first (primary-key prefix), then each
    // thread by id. Left to itself the planner may walk every thread in updated_at order instead.
    const from = "from mesh_thread_participants p cross join mesh_threads t on t.id = p.thread_id where p.x_user_id = ?";
    const rows = status
      ? this.all(`select t.* ${from} and t.status = ? order by t.updated_at desc, t.rowid desc limit 100`, xUserId, status)
      : this.all(`select t.* ${from} order by t.updated_at desc, t.rowid desc limit 100`, xUserId);
    return rows.map((r) => thread(r)!);
  }
  async insertMessage(m: NewMessage, opts?: WriteOptions) {
    return this.tx(() => {
      const row = message(
        this.must(
          "insert into mesh_messages (id, thread_id, from_x_user_id, kind, message, needs_human, created_at) values (?, ?, ?, ?, ?, ?, ?) returning *",
          m.id ?? randomUUID(), m.thread_id, m.from_x_user_id, m.kind, JSON.stringify(m.message), m.needs_human ? 1 : 0, this.stamp(),
        ),
      )!;
      this.count(row.from_x_user_id, "mesh_messages", row.id, opts);
      return row;
    });
  }
  async listMessages(threadId: string, limit: number) {
    const n = Math.max(0, Math.floor(limit));
    return this.all("select * from mesh_messages where thread_id = ? order by rowid desc limit ?", threadId, n)
      .reverse()
      .map((r) => message(r)!);
  }
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

function agent(r: Row | undefined): Agent | null {
  if (!r) return null;
  return {
    id: String(r.id),
    x_user_id: String(r.x_user_id),
    x_handle: String(r.x_handle),
    agent_card_url: text(r.agent_card_url),
    display_name: text(r.display_name),
    owner_opt_in: Boolean(r.owner_opt_in),
    opted_in_at: text(r.opted_in_at),
    x_verified: Boolean(r.x_verified),
    api_key_hash: text(r.api_key_hash),
    stored_bytes: Number(r.stored_bytes ?? 0),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}
function thread(r: Row | undefined): Thread | null {
  if (!r) return null;
  return {
    id: String(r.id),
    goal: String(r.goal),
    proposer_x_user_id: String(r.proposer_x_user_id),
    participants: JSON.parse(String(r.participants)) as string[],
    accepted_by: JSON.parse(String(r.accepted_by)) as string[],
    status: r.status as ThreadStatus,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}
function message(r: Row | undefined): StoredMessage | null {
  if (!r) return null;
  return {
    id: String(r.id),
    thread_id: String(r.thread_id),
    from_x_user_id: String(r.from_x_user_id),
    kind: r.kind as StoredMessage["kind"],
    message: JSON.parse(String(r.message)) as Record<string, unknown>,
    needs_human: Boolean(r.needs_human),
    created_at: String(r.created_at),
  };
}
