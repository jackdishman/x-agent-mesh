// The mesh's rules, shared by the MCP tools (mcp.ts) and the A2A endpoint (a2a.ts).
// Nothing in here posts to X, sends a DM or moves money: the server only stores coordination
// state and hands text back to the calling agent, whose owner decides what happens next.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { LIMITS, type MeshConfig } from "./config.js";
import { RateLimiter } from "./ratelimit.js";
import type { Agent, MessageKind, Store, StoredMessage, Thread, ThreadStatus } from "./store.js";
import { clean, cleanData } from "./untrusted.js";
import { UNVERIFIED_FLAG, X_VERIFICATION_TODO } from "./xauth.js";

export type MeshErrorCode = "unauthorized" | "forbidden" | "not_found" | "invalid" | "conflict" | "rate_limited";

export class MeshError extends Error {
  constructor(
    public code: MeshErrorCode,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Who is calling: the bearer key (HTTP) or MESH_AGENT_KEY (stdio), and where from. */
export interface CallContext {
  apiKey?: string;
  ip: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const OPEN: ThreadStatus[] = ["active", "input_required"];
const TERMINAL: ThreadStatus[] = ["completed", "declined", "canceled"];
const NO_THREAD = "No such thread, or you are not a participant in it.";

export interface RegisterInput {
  x_user_id: string;
  x_handle: string;
  agent_card_url?: string;
  display_name?: string;
}

export interface PostInput {
  text: string;
  data?: Record<string, unknown>;
  needsHuman?: boolean;
  /** 'active' resumes an input_required thread; 'completed' closes the thread. */
  setStatus?: "active" | "completed";
  kind?: MessageKind;
  role?: "agent" | "user";
  messageId?: string;
}

export class Mesh {
  private agentLimiter: RateLimiter;
  private ipLimiter: RateLimiter;
  private authFailLimiter: RateLimiter;
  /** The mutual set each agent last supplied (x_user_id → ids), kept for cfg.mutualTtlMs. In memory: lost on restart. */
  private mutuals = new Map<string, { ids: Set<string>; at: number }>();

  constructor(
    public store: Store,
    public cfg: MeshConfig,
    private now: () => number = Date.now,
  ) {
    this.agentLimiter = new RateLimiter(cfg.agentRate, now);
    this.ipLimiter = new RateLimiter(cfg.ipRate, now);
    this.authFailLimiter = new RateLimiter({ capacity: 30, refillPerSec: 0.5 }, now);
  }

  // ---- auth and limits ----

  private limit(limiter: RateLimiter, key: string, what: string) {
    const wait = limiter.take(key);
    if (wait > 0) throw new MeshError("rate_limited", `Rate limit reached for ${what}. Wait ${wait} seconds before trying again; do not retry in a loop.`, wait);
  }

  /** The agent behind the key, after taking one token from its bucket. Every tool except register_agent and every A2A call goes through here. */
  async auth(ctx: CallContext): Promise<Agent> {
    const agent = ctx.apiKey ? await this.store.getAgentByKeyHash(sha256(ctx.apiKey)) : null;
    if (!agent) {
      this.limit(this.authFailLimiter, ctx.ip, "failed authentication from this address");
      throw new MeshError(
        "unauthorized",
        ctx.apiKey
          ? "Unknown agent API key."
          : "An agent API key is required: send `Authorization: Bearer <key>` (HTTP) or set MESH_AGENT_KEY (stdio). Call register_agent to get one.",
      );
    }
    this.limit(this.agentLimiter, agent.id, "this agent");
    return agent;
  }

  // ---- registration ----

  async register(ctx: CallContext, input: RegisterInput) {
    this.limit(this.ipLimiter, ctx.ip, "registrations from this address");
    const existing = await this.store.getAgentByXUserId(input.x_user_id);
    if (existing) {
      const ok = ctx.apiKey && existing.api_key_hash && sameHash(sha256(ctx.apiKey), existing.api_key_hash);
      if (!ok) {
        throw new MeshError("forbidden", "This x_user_id is already registered. Re-registering (which rotates the key) requires the agent's current API key as the bearer token / MESH_AGENT_KEY.");
      }
    }
    const holder = await this.store.getAgentByHandle(input.x_handle);
    if (holder && holder.x_user_id !== input.x_user_id) {
      throw new MeshError("conflict", "This x_handle is already registered to a different x_user_id.");
    }
    const apiKey = `xam_${randomBytes(32).toString("base64url")}`;
    const fields = {
      x_handle: input.x_handle,
      agent_card_url: input.agent_card_url ?? null,
      display_name: input.display_name ? clean(input.display_name, 100) : null,
      owner_opt_in: true,
      opted_in_at: existing?.opted_in_at ?? new Date(this.now()).toISOString(),
      api_key_hash: sha256(apiKey),
    };
    const agent = existing ? await this.store.updateAgent(existing.x_user_id, fields) : await this.store.insertAgent({ x_user_id: input.x_user_id, ...fields });
    return { agent, apiKey, rotated: Boolean(existing) };
  }

  // ---- mutuals ----

  private usable(a: Agent): boolean {
    return a.owner_opt_in && (!this.cfg.requireVerified || a.x_verified);
  }

  private rememberMutuals(xUserId: string, ids: Set<string>) {
    const t = this.now();
    if (this.mutuals.size >= 5000) {
      for (const [k, v] of this.mutuals) if (t - v.at > this.cfg.mutualTtlMs) this.mutuals.delete(k);
      if (this.mutuals.size >= 5000) this.mutuals.delete(this.mutuals.keys().next().value as string);
    }
    this.mutuals.delete(xUserId);
    this.mutuals.set(xUserId, { ids, at: t });
  }

  private rememberedMutuals(xUserId: string): Set<string> | null {
    const m = this.mutuals.get(xUserId);
    if (!m) return null;
    if (this.now() - m.at > this.cfg.mutualTtlMs) {
      this.mutuals.delete(xUserId);
      return null;
    }
    return m.ids;
  }

  private intersect(self: Agent, followerIds: string[], followingIds: string[]): Set<string> {
    const followers = new Set(followerIds);
    const out = new Set<string>();
    for (const id of followingIds) if (followers.has(id) && id !== self.x_user_id) out.add(id);
    return out;
  }

  /** Intersects the two lists, remembers the mutual set for the caller, and returns the opted-in registered agents in it. */
  async listMutuals(self: Agent, followerIds: string[], followingIds: string[]) {
    const ids = this.intersect(self, followerIds, followingIds);
    this.rememberMutuals(self.x_user_id, ids);
    const agents = (await this.store.getOptedInAgents([...ids])).filter((a) => ids.has(a.x_user_id) && this.usable(a));
    return { mutualCount: ids.size, agents, rememberedUntil: new Date(this.now() + this.cfg.mutualTtlMs).toISOString() };
  }

  // ---- threads ----

  /**
   * Who may be proposed to (the documented v0 choice): every participant must be in the caller's
   * mutual set, as passed here or as last supplied to list_mutual_agents within the TTL, and must
   * be a registered, opted-in agent. The lists are the caller's own claim (the server cannot read
   * X in v0); the other side's consent is the accept step.
   */
  async propose(self: Agent, goal: string, participantIds: string[], lists?: { followerIds: string[]; followingIds: string[] }): Promise<Thread> {
    if (!self.owner_opt_in) throw new MeshError("forbidden", "Your owner has not opted in.");
    if (this.cfg.requireVerified && !self.x_verified) {
      throw new MeshError("forbidden", `This mesh requires X-verified agents (MESH_REQUIRE_VERIFIED=1) and yours is not verified. ${X_VERIFICATION_TODO}`);
    }
    const others = [...new Set(participantIds)].filter((id) => id !== self.x_user_id);
    if (others.length === 0) throw new MeshError("invalid", "Name at least one participant other than yourself.");
    if (others.length + 1 > LIMITS.participants) throw new MeshError("invalid", `A thread has at most ${LIMITS.participants} participants, including you.`);

    let mutualIds: Set<string> | null;
    if (lists) {
      mutualIds = this.intersect(self, lists.followerIds, lists.followingIds);
      this.rememberMutuals(self.x_user_id, mutualIds);
    } else {
      mutualIds = this.rememberedMutuals(self.x_user_id);
    }
    if (!mutualIds) {
      throw new MeshError("forbidden", "The server has no recent mutual set for you. Call list_mutual_agents with your owner's follower and following IDs first (remembered for a limited time), or pass follower_ids and following_ids here.");
    }
    const notMutual = others.filter((id) => !mutualIds.has(id));
    if (notMutual.length) throw new MeshError("forbidden", `Not among your mutuals as last supplied: ${notMutual.join(", ")}. You can only propose goals to mutuals.`);
    const registered = new Set((await this.store.getOptedInAgents(others)).filter((a) => this.usable(a)).map((a) => a.x_user_id));
    const missing = others.filter((id) => !registered.has(id));
    if (missing.length) throw new MeshError("forbidden", `Not registered, opted-in${this.cfg.requireVerified ? ", verified" : ""} mesh agents: ${missing.join(", ")}.`);

    const thread = await this.store.insertThread({
      goal,
      proposer_x_user_id: self.x_user_id,
      participants: [self.x_user_id, ...others],
      accepted_by: [self.x_user_id],
      status: "proposed",
    });
    await this.record(thread.id, self, "proposal", { text: goal });
    return thread;
  }

  /** The thread, if the caller participates in it (same error whether it's missing or someone else's). */
  async thread(self: Agent, threadId: string): Promise<Thread> {
    const t = await this.store.getThread(threadId);
    if (!t || !t.participants.includes(self.x_user_id)) throw new MeshError("not_found", NO_THREAD);
    return t;
  }

  async threads(self: Agent, status?: ThreadStatus): Promise<Thread[]> {
    return (await this.store.listThreadsFor(self.x_user_id, status)).filter((t) => t.participants.includes(self.x_user_id));
  }

  async messages(self: Agent, threadId: string, limit: number = LIMITS.readDefault): Promise<{ thread: Thread; messages: StoredMessage[] }> {
    const thread = await this.thread(self, threadId);
    return { thread, messages: await this.store.listMessages(threadId, Math.min(Math.max(1, limit), LIMITS.readMax)) };
  }

  /** Read, decide, compare-and-set; retried when another participant changed the thread in between. */
  private async transition(self: Agent, threadId: string, decide: (t: Thread) => { accepted_by?: string[]; status?: ThreadStatus } | null): Promise<Thread> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const t = await this.thread(self, threadId);
      const patch = decide(t);
      if (!patch) return t;
      const updated = await this.store.updateThread(threadId, patch, t.updated_at);
      if (updated) return updated;
    }
    throw new MeshError("conflict", "The thread is being changed by other participants. Try again shortly.");
  }

  private async record(threadId: string, self: Agent, kind: MessageKind, m: { text: string; data?: Record<string, unknown>; needsHuman?: boolean; role?: "agent" | "user"; messageId?: string }): Promise<StoredMessage> {
    return this.store.insertMessage({
      thread_id: threadId,
      from_x_user_id: self.x_user_id,
      kind,
      needs_human: m.needsHuman ?? false,
      message: {
        kind: "message",
        role: m.role ?? "agent",
        parts: [{ kind: "text", text: m.text }, ...(m.data ? [{ kind: "data", data: m.data }] : [])],
        messageId: m.messageId ?? randomUUID(),
        contextId: threadId,
        taskId: threadId,
        metadata: { from_x_user_id: self.x_user_id, from_x_handle: self.x_handle },
      },
    });
  }

  async accept(self: Agent, threadId: string, accept: boolean): Promise<Thread> {
    const thread = await this.transition(self, threadId, (t) => {
      if (t.status !== "proposed") throw new MeshError("conflict", `This thread is ${t.status}; only a proposed thread can be accepted or declined.`);
      if (!accept) return { status: "declined" };
      const accepted = [...new Set([...t.accepted_by, self.x_user_id])];
      return { accepted_by: accepted, status: t.participants.every((p) => accepted.includes(p)) ? "active" : "proposed" };
    });
    await this.record(threadId, self, accept ? "accept" : "decline", { text: accept ? "Accepted the goal." : "Declined the goal." });
    return thread;
  }

  async post(self: Agent, threadId: string, input: PostInput): Promise<{ thread: Thread; message: StoredMessage }> {
    if (input.needsHuman && input.setStatus) throw new MeshError("invalid", "needs_human and set_status cannot be combined.");
    if (input.data && Buffer.byteLength(JSON.stringify(input.data)) > LIMITS.dataBytes) throw new MeshError("invalid", `data is limited to ${LIMITS.dataBytes} bytes of JSON.`);
    const thread = await this.transition(self, threadId, (t) => {
      if (!OPEN.includes(t.status)) throw new MeshError("conflict", `This thread is ${t.status}; updates need an active or input_required thread.`);
      const next: ThreadStatus = input.needsHuman ? "input_required" : (input.setStatus ?? t.status);
      return next === t.status ? null : { status: next };
    });
    const message = await this.record(threadId, self, input.kind ?? (input.setStatus ? "status" : "update"), input);
    return { thread, message };
  }

  /** Records the question and marks the thread input_required. Messages nobody: the caller asks its own owner. */
  async escalate(self: Agent, threadId: string, question: string, context?: string) {
    return this.post(self, threadId, {
      text: context ? `${question}\n\nContext: ${context}` : question,
      needsHuman: true,
      kind: "escalation",
    });
  }

  /**
   * A payment DRAFT: a record that one participant proposes to pay another. This is the whole of
   * the payments feature. The server has no payment credentials, calls no payment API, and there
   * is no code path here or anywhere else in this repo that moves money.
   */
  async proposePayment(self: Agent, threadId: string, p: { toHandle: string; amount: number; currency: string; memo: string }) {
    const t = await this.thread(self, threadId);
    if (!OPEN.includes(t.status)) throw new MeshError("conflict", `This thread is ${t.status}; payment drafts need an active or input_required thread.`);
    const payee = await this.store.getAgentByHandle(p.toHandle);
    if (!payee || !t.participants.includes(payee.x_user_id) || payee.x_user_id === self.x_user_id) {
      throw new MeshError("forbidden", "Payment drafts can only name another participant of this thread as the payee.");
    }
    const draft = {
      type: "payment_draft",
      status: "draft" as const,
      moves_money: false as const,
      from_x_handle: self.x_handle,
      to_x_handle: payee.x_handle,
      to_x_user_id: payee.x_user_id,
      amount: p.amount,
      currency: p.currency,
      memo: p.memo,
    };
    const message = await this.record(threadId, self, "payment_draft", {
      text: `Payment draft (not sent, moves no money): @${self.x_handle} proposes to pay @${payee.x_handle} ${p.amount} ${p.currency}.`,
      data: draft,
    });
    return { thread: t, draft: { draft_id: message.id, thread_id: threadId, ...draft, created_at: message.created_at } };
  }

  async cancel(self: Agent, threadId: string): Promise<Thread> {
    const thread = await this.transition(self, threadId, (t) => {
      if (TERMINAL.includes(t.status)) throw new MeshError("conflict", `This thread is already ${t.status} and cannot be canceled.`);
      return { status: "canceled" };
    });
    await this.record(threadId, self, "status", { text: "Canceled the thread." });
    return thread;
  }
}

// ---- views: what a calling agent is shown. Built field by field; other agents' text only under untrusted_*. ----

export function agentView(a: Agent, publicUrl: string) {
  return {
    x_user_id: a.x_user_id,
    x_handle: a.x_handle,
    untrusted_display_name: a.display_name === null ? null : clean(a.display_name, 100),
    untrusted_agent_card_url: a.agent_card_url === null ? null : clean(a.agent_card_url, 500),
    mesh_agent_card_url: `${publicUrl}/agents/${encodeURIComponent(a.x_handle)}/.well-known/agent-card.json`,
    x_verified: a.x_verified,
    ...(a.x_verified ? {} : { verification: UNVERIFIED_FLAG }),
  };
}

export function threadView(t: Thread, self: Agent) {
  return {
    thread_id: t.id,
    status: t.status,
    untrusted_goal: clean(t.goal, LIMITS.goal),
    proposer_x_user_id: t.proposer_x_user_id,
    proposed_by_me: t.proposer_x_user_id === self.x_user_id,
    participants: t.participants,
    accepted_by: t.accepted_by,
    waiting_on: t.status === "proposed" ? t.participants.filter((p) => !t.accepted_by.includes(p)) : [],
    needs_human: t.status === "input_required",
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

/** The text and data parts of a stored A2A message, cleaned. */
export function messageContent(m: StoredMessage): { text: string; data: unknown[] } {
  const parts = Array.isArray(m.message.parts) ? (m.message.parts as unknown[]) : [];
  const texts: string[] = [];
  const data: unknown[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const part = p as Record<string, unknown>;
    if (part.kind === "text" && typeof part.text === "string") texts.push(part.text);
    else if (part.kind === "data") data.push(cleanData(part.data));
  }
  return { text: clean(texts.join(" "), LIMITS.text), data };
}

export function messageView(m: StoredMessage, self: Agent) {
  const { text, data } = messageContent(m);
  return {
    message_id: m.id,
    kind: m.kind,
    from_x_user_id: m.from_x_user_id,
    from_me: m.from_x_user_id === self.x_user_id,
    needs_human: m.needs_human,
    created_at: m.created_at,
    untrusted_text: text,
    ...(data.length ? { untrusted_data: data.length === 1 ? data[0] : data } : {}),
  };
}
