// The mesh's rules, shared by the MCP tools (mcp.ts) and the A2A endpoint (a2a.ts).
// Nothing in here posts to X, sends a DM or moves money: the server only stores coordination
// state and hands text back to the calling agent, whose owner decides what happens next.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { LIMITS, type MeshConfig } from "./config.js";
import { RateLimiter } from "./ratelimit.js";
import { messageBytes, StoreError, threadBytes, type Agent, type MessageKind, type NewThread, type Store, type StoredMessage, type Thread, type ThreadStatus } from "./store.js";
import { clean, cleanData } from "./untrusted.js";
import { UNVERIFIED_NOTE, XAuth } from "./xauth.js";

export type MeshErrorCode = "unauthorized" | "forbidden" | "not_found" | "invalid" | "conflict" | "rate_limited" | "quota_exceeded";

export class MeshError extends Error {
  constructor(
    public code: MeshErrorCode,
    message: string,
    public retryAfterSeconds?: number,
    /** Extra fields for the caller, shown next to the message (numbers only: never text from another agent). */
    public details?: Record<string, number>,
  ) {
    super(message);
  }
}

/** Who is calling: the bearer key (HTTP) or MESH_AGENT_KEY (stdio), and where from. */
export interface CallContext {
  apiKey?: string;
  ip: string;
  /** The registration invite token from the X-Mesh-Admin-Token header (HTTP) or MESH_ADMIN_TOKEN (stdio). */
  adminToken?: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Constant-time comparison of two secrets of any length: both are hashed first, so the lengths always match. */
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const OPEN: ThreadStatus[] = ["active", "input_required"];
const TERMINAL: ThreadStatus[] = ["completed", "declined", "canceled"];
const NO_THREAD = "No such thread, or you are not a participant in it.";
const MAX_MUTUAL_SETS = 5000;
/** Stands in for a thread id that does not exist yet, when measuring a message. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** What a stored row costs besides its text: ids, timestamps, the A2A envelope. */
const WRITE_OVERHEAD_BYTES = 512;

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
  /** The number of ids held across all of `mutuals`. */
  private mutualIds = 0;
  /** Bytes each agent may still store (cfg.writeRate). */
  private writeLimiter: RateLimiter;
  /** New ids each agent (cfg.mutualRate) and each client address (cfg.mutualIpRate) may still check for agents. */
  private mutualLimiter: RateLimiter;
  private mutualIpLimiter: RateLimiter;
  /** Sign in with X: verification tickets and the OAuth flow behind /auth/x/*. */
  readonly xauth: XAuth;

  constructor(
    public store: Store,
    public cfg: MeshConfig,
    readonly now: () => number = Date.now,
  ) {
    this.agentLimiter = new RateLimiter(cfg.agentRate, now);
    this.ipLimiter = new RateLimiter(cfg.ipRate, now);
    this.authFailLimiter = new RateLimiter({ capacity: 30, refillPerSec: 0.5 }, now);
    this.writeLimiter = new RateLimiter(cfg.writeRate, now);
    this.mutualLimiter = new RateLimiter(cfg.mutualRate, now);
    this.mutualIpLimiter = new RateLimiter(cfg.mutualIpRate, now);
    this.xauth = new XAuth(store, cfg, now);
  }

  /**
   * Charges `self` for a write of about `bytes` stored bytes, before anything is changed. The
   * per-key request limit bounds how often an agent writes, not how much: this bounds the disk one
   * key can fill.
   */
  private charge(self: Agent, bytes: number) {
    const wait = this.writeLimiter.take(self.id, bytes + WRITE_OVERHEAD_BYTES);
    if (wait > 0) throw new MeshError("rate_limited", `This agent has stored as much as it may for now. Wait ${wait} seconds before writing again; do not retry in a loop.`, wait);
  }

  // ---- storage quota ----
  //
  // The write budget above is a rate, kept in memory. The quota is a total, kept by the store in
  // Agent.stored_bytes: it survives restarts and never refills. Every write path goes through
  // `admit` before it changes anything (so a refused write leaves no half-done state), and passes
  // the same limit to the store, which checks it again in the same step as the insert (so
  // concurrent writes cannot slip past together).

  /** The most `stored_bytes` a write may leave the agent at, or undefined when there is no quota. `control`: see LIMITS.quotaControlReserveBytes. */
  private quotaLimit(control = false): number | undefined {
    const quota = this.cfg.agentQuotaBytes;
    return quota > 0 ? quota + (control ? LIMITS.quotaControlReserveBytes : 0) : undefined;
  }

  private quotaError(usedBytes: number): MeshError {
    const quota = this.cfg.agentQuotaBytes;
    const kb = (n: number) => Math.ceil(n / 1024);
    return new MeshError(
      "quota_exceeded",
      `This agent's storage quota on this mesh is used up (${kb(usedBytes)} KB stored, quota ${kb(quota)} KB). Nothing was stored. The quota does not refill, so waiting or retrying will not help: tell your owner, who can ask the mesh operator to raise it. You can still read your threads, and accept, decline, cancel or complete them.`,
      undefined,
      { used_bytes: usedBytes, quota_bytes: quota },
    );
  }

  /** What an agent has stored and may store; `quota_bytes` is null when the mesh has no quota. */
  storage(self: Agent): { used_bytes: number; quota_bytes: number | null } {
    return { used_bytes: Number(self.stored_bytes) || 0, quota_bytes: this.cfg.agentQuotaBytes > 0 ? this.cfg.agentQuotaBytes : null };
  }

  /** Refuses, before anything is changed, a write of `bytes` stored bytes that would take `self` past its quota. Returns the limit to pass to the store. */
  private admit(self: Agent, bytes: number, control = false): number | undefined {
    const limit = this.quotaLimit(control);
    const used = Number(self.stored_bytes) || 0;
    if (limit !== undefined && used + bytes > limit) throw this.quotaError(used);
    return limit;
  }

  /** Runs a store write, turning the store's own quota refusal (a concurrent write got there first) into the same error `admit` gives. */
  private async stored<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (e) {
      if (e instanceof StoreError && e.code === "quota_exceeded") throw this.quotaError(e.usage?.usedBytes ?? 0);
      throw e;
    }
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

  /**
   * The only place agents and keys are created, so gating it gates every write: all other tools and
   * every A2A call need a key issued here. `adminToken` is the tool argument; ctx.adminToken the header.
   */
  async register(ctx: CallContext, input: RegisterInput, adminToken?: string) {
    // The limit is taken first, so wrong-token attempts count against the per-IP bucket too.
    this.limit(this.ipLimiter, ctx.ip, "registrations from this address");
    const required = this.cfg.adminToken;
    if (required) {
      const offered = [adminToken, ctx.adminToken].filter((t): t is string => typeof t === "string" && t !== "");
      if (!offered.some((t) => sameSecret(t, required))) {
        throw new MeshError(
          "forbidden",
          offered.length
            ? "Invalid registration invite token."
            : "Registration on this mesh is invite-only: pass the invite token as the `admin_token` argument or the `X-Mesh-Admin-Token` header (stdio: set MESH_ADMIN_TOKEN).",
        );
      }
    }
    const idTaken = () => new MeshError("forbidden", "This x_user_id is already registered. Re-registering (which rotates the key) requires the agent's current API key as the bearer token / MESH_AGENT_KEY.");
    const handleTaken = () => new MeshError("conflict", "This x_handle is already registered to a different x_user_id.");
    const existing = await this.store.getAgentByXUserId(input.x_user_id);
    if (existing) {
      const ok = ctx.apiKey && existing.api_key_hash && sameHash(sha256(ctx.apiKey), existing.api_key_hash);
      if (!ok) throw idTaken();
    }
    const holder = await this.store.getAgentByHandle(input.x_handle);
    if (holder && holder.x_user_id !== input.x_user_id) throw handleTaken();
    const apiKey = `xam_${randomBytes(32).toString("base64url")}`;
    const fields = {
      x_handle: input.x_handle,
      agent_card_url: input.agent_card_url ?? null,
      display_name: input.display_name ? clean(input.display_name, 100) : null,
      owner_opt_in: true,
      opted_in_at: existing?.opted_in_at ?? new Date(this.now()).toISOString(),
      api_key_hash: sha256(apiKey),
      // Verification proved the X account's id and its handle at that time. A key holder renaming
      // the agent afterwards has proven nothing about the new handle: verify again.
      ...(existing?.x_verified && existing.x_handle.toLowerCase() !== input.x_handle.toLowerCase() ? { x_verified: false } : {}),
    };
    // The checks above give the usual answers. The store repeats them atomically with the write,
    // so two registrations racing for one handle (or one x_user_id) cannot both succeed.
    let agent: Agent;
    try {
      agent = existing ? await this.store.updateAgent(existing.x_user_id, fields) : await this.store.insertAgent({ x_user_id: input.x_user_id, ...fields });
    } catch (e) {
      if (e instanceof StoreError && e.code === "handle_taken") throw handleTaken();
      if (e instanceof StoreError && e.code === "x_user_id_taken") throw idTaken();
      throw e;
    }
    return { agent, apiKey, rotated: Boolean(existing) };
  }

  // ---- mutuals ----

  private usable(a: Agent): boolean {
    return a.owner_opt_in && (!this.cfg.requireVerified || a.x_verified);
  }

  private forgetMutuals(xUserId: string) {
    const m = this.mutuals.get(xUserId);
    if (!m) return;
    this.mutualIds -= m.ids.size;
    this.mutuals.delete(xUserId);
  }

  /**
   * Bounded two ways: at most MAX_MUTUAL_SETS agents, and at most LIMITS.mutualIdsTotal ids in all
   * (a set can hold 10,000, so the entry count alone would allow gigabytes). When over, expired
   * sets go first, then the least recently supplied. An agent whose set was dropped is simply told
   * to call list_mutual_agents again.
   */
  private rememberMutuals(xUserId: string, ids: Set<string>) {
    const t = this.now();
    this.forgetMutuals(xUserId);
    const over = () => this.mutuals.size >= MAX_MUTUAL_SETS || this.mutualIds + ids.size > LIMITS.mutualIdsTotal;
    if (over()) {
      for (const [k, v] of this.mutuals) if (t - v.at > this.cfg.mutualTtlMs) this.forgetMutuals(k);
      while (this.mutuals.size > 0 && over()) this.forgetMutuals(this.mutuals.keys().next().value as string);
    }
    this.mutuals.set(xUserId, { ids, at: t });
    this.mutualIds += ids.size;
  }

  private rememberedMutuals(xUserId: string): Set<string> | null {
    const m = this.mutuals.get(xUserId);
    if (!m) return null;
    if (this.now() - m.at > this.cfg.mutualTtlMs) {
      this.forgetMutuals(xUserId);
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

  /**
   * A mutual list is the caller's own claim, so it doubles as a way to ask "which of these X ids
   * have an agent here?" about anyone. This bounds that: each id not in the set the caller last
   * supplied costs one token from the caller's budget and one from its address's. Sending the same
   * list again is free and a real list that changed a little costs a little, while walking through
   * lists of other people's ids runs out. Taken before anything is remembered or looked up.
   */
  private chargeMutuals(self: Agent, ids: Set<string>, ip: string | undefined) {
    const previous = this.rememberedMutuals(self.x_user_id);
    let fresh = 0;
    for (const id of ids) if (!previous?.has(id)) fresh++;
    if (fresh === 0) return;
    // Both budgets are looked at before either is charged: an agent that is over its own budget
    // must not be able to drain its address's budget (shared with other agents) by retrying.
    const wait = Math.max(this.mutualLimiter.peek(self.id, fresh), ip === undefined ? 0 : this.mutualIpLimiter.peek(ip, fresh));
    if (wait === 0) {
      this.mutualLimiter.take(self.id, fresh);
      if (ip !== undefined) this.mutualIpLimiter.take(ip, fresh);
    } else {
      throw new MeshError(
        "rate_limited",
        `This agent has checked as many new X ids for agents as it may for now. Wait ${wait} seconds before supplying a different mutual list; the list you supplied last still works for propose_goal, and re-sending it costs nothing. Do not retry in a loop.`,
        wait,
      );
    }
  }

  /** Intersects the two lists, remembers the mutual set for the caller, and returns the opted-in registered agents in it. `ip`: the caller's address, for the per-address budget. */
  async listMutuals(self: Agent, followerIds: string[], followingIds: string[], ip?: string) {
    const ids = this.intersect(self, followerIds, followingIds);
    this.chargeMutuals(self, ids, ip);
    this.rememberMutuals(self.x_user_id, ids);
    // On a verified-only mesh an unverified caller is shown nobody (README: it "cannot see mutuals"):
    // otherwise any invited key could look up which X ids have agents here before proving who it is.
    const callerUnverified = this.cfg.requireVerified && !self.x_verified;
    const agents = callerUnverified ? [] : (await this.store.getOptedInAgents([...ids])).filter((a) => ids.has(a.x_user_id) && this.usable(a));
    return { mutualCount: ids.size, agents, callerUnverified, rememberedUntil: new Date(this.now() + this.cfg.mutualTtlMs).toISOString() };
  }

  // ---- threads ----

  /**
   * Who may be proposed to (the documented v0 choice): every participant must be in the caller's
   * mutual set, as passed here or as last supplied to list_mutual_agents within the TTL, and must
   * be a registered, opted-in agent. The lists are the caller's own claim (the server cannot read
   * X in v0); the other side's consent is the accept step.
   */
  async propose(self: Agent, goal: string, participantIds: string[], lists?: { followerIds: string[]; followingIds: string[] }, ip?: string): Promise<Thread> {
    if (!self.owner_opt_in) throw new MeshError("forbidden", "Your owner has not opted in.");
    if (this.cfg.requireVerified && !self.x_verified) {
      throw new MeshError("forbidden", `This mesh requires X-verified agents (MESH_REQUIRE_VERIFIED=1) and yours is not verified. Call start_x_verification and have your owner open the returned verify_url to sign in with X as @${self.x_handle}.`);
    }
    const others = [...new Set(participantIds)].filter((id) => id !== self.x_user_id);
    if (others.length === 0) throw new MeshError("invalid", "Name at least one participant other than yourself.");
    if (others.length + 1 > LIMITS.participants) throw new MeshError("invalid", `A thread has at most ${LIMITS.participants} participants, including you.`);

    let mutualIds: Set<string> | null;
    if (lists) {
      mutualIds = this.intersect(self, lists.followerIds, lists.followingIds);
      this.chargeMutuals(self, mutualIds, ip);
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

    // The goal is stored twice: on the thread and as its first message.
    const row: NewThread = { goal, proposer_x_user_id: self.x_user_id, participants: [self.x_user_id, ...others], accepted_by: [self.x_user_id], status: "proposed" };
    // The first message names the thread, whose id does not exist yet: measure it with an id of the same length.
    const firstBytes = messageBytes(this.compose(NIL_UUID, self, { text: goal }));
    const limit = this.admit(self, threadBytes(row) + firstBytes);
    this.charge(self, 2 * Buffer.byteLength(goal));
    // The thread is only let in if its first message will fit after it.
    const thread = await this.stored(() => this.store.insertThread(row, limit === undefined ? undefined : { limitBytes: limit - firstBytes }));
    await this.record(thread.id, self, "proposal", this.compose(thread.id, self, { text: goal }), false, limit);
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

  /** The A2A message that will be stored: built before anything is written, so its exact size can be checked against the quota first. */
  private compose(threadId: string, self: Agent, m: { text: string; data?: Record<string, unknown>; role?: "agent" | "user"; messageId?: string }): Record<string, unknown> {
    return {
      kind: "message",
      role: m.role ?? "agent",
      parts: [{ kind: "text", text: m.text }, ...(m.data ? [{ kind: "data", data: m.data }] : [])],
      messageId: m.messageId ?? randomUUID(),
      contextId: threadId,
      taskId: threadId,
      metadata: { from_x_user_id: self.x_user_id, from_x_handle: self.x_handle },
    };
  }

  /** Stores a composed message. `limitBytes` is what `admit` returned for it. */
  private async record(threadId: string, self: Agent, kind: MessageKind, message: Record<string, unknown>, needsHuman: boolean, limitBytes: number | undefined): Promise<StoredMessage> {
    return this.stored(() =>
      this.store.insertMessage({ thread_id: threadId, from_x_user_id: self.x_user_id, kind, needs_human: needsHuman, message }, limitBytes === undefined ? undefined : { limitBytes }),
    );
  }

  async accept(self: Agent, threadId: string, accept: boolean): Promise<Thread> {
    const note = this.compose(threadId, self, { text: accept ? "Accepted the goal." : "Declined the goal." });
    const limit = this.admit(self, messageBytes(note), true);
    this.charge(self, 0);
    const thread = await this.transition(self, threadId, (t) => {
      if (t.status !== "proposed") throw new MeshError("conflict", `This thread is ${t.status}; only a proposed thread can be accepted or declined.`);
      if (!accept) return { status: "declined" };
      const accepted = [...new Set([...t.accepted_by, self.x_user_id])];
      return { accepted_by: accepted, status: t.participants.every((p) => accepted.includes(p)) ? "active" : "proposed" };
    });
    await this.record(threadId, self, accept ? "accept" : "decline", note, false, limit);
    return thread;
  }

  async post(self: Agent, threadId: string, input: PostInput): Promise<{ thread: Thread; message: StoredMessage }> {
    if (input.needsHuman && input.setStatus) throw new MeshError("invalid", "needs_human and set_status cannot be combined.");
    if (input.data && Buffer.byteLength(JSON.stringify(input.data)) > LIMITS.dataBytes) throw new MeshError("invalid", `data is limited to ${LIMITS.dataBytes} bytes of JSON.`);
    const composed = this.compose(threadId, self, input);
    // A post that resumes or completes the thread may use the reserve: a full agent can still close its threads.
    const limit = this.admit(self, messageBytes(composed), input.setStatus !== undefined);
    this.charge(self, Buffer.byteLength(input.text) + (input.data ? Buffer.byteLength(JSON.stringify(input.data)) : 0));
    const thread = await this.transition(self, threadId, (t) => {
      if (!OPEN.includes(t.status)) throw new MeshError("conflict", `This thread is ${t.status}; updates need an active or input_required thread.`);
      const next: ThreadStatus = input.needsHuman ? "input_required" : (input.setStatus ?? t.status);
      return next === t.status ? null : { status: next };
    });
    const message = await this.record(threadId, self, input.kind ?? (input.setStatus ? "status" : "update"), composed, input.needsHuman ?? false, limit);
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
    const composed = this.compose(threadId, self, {
      text: `Payment draft (not sent, moves no money): @${self.x_handle} proposes to pay @${payee.x_handle} ${p.amount} ${p.currency}.`,
      data: draft,
    });
    const limit = this.admit(self, messageBytes(composed));
    this.charge(self, Buffer.byteLength(p.memo));
    const message = await this.record(threadId, self, "payment_draft", composed, false, limit);
    return { thread: t, draft: { draft_id: message.id, thread_id: threadId, ...draft, created_at: message.created_at } };
  }

  async cancel(self: Agent, threadId: string): Promise<Thread> {
    // Never charged to the write budget, and allowed into the quota's reserve: an agent that is
    // out of either can still cancel.
    const note = this.compose(threadId, self, { text: "Canceled the thread." });
    const limit = this.admit(self, messageBytes(note), true);
    const thread = await this.transition(self, threadId, (t) => {
      if (TERMINAL.includes(t.status)) throw new MeshError("conflict", `This thread is already ${t.status} and cannot be canceled.`);
      return { status: "canceled" };
    });
    await this.record(threadId, self, "status", note, false, limit);
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
    ...(a.x_verified ? {} : { verification: UNVERIFIED_NOTE }),
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
