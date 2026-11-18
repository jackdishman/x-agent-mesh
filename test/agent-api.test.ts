// The agent API end to end over real HTTP (POST /mcp and POST /a2a on a loopback server):
// authentication, the invite-token gate, registration, listing, proposals, verified-only gating and
// input validation. X is faked (test/http-helpers.ts): no real network, no real credentials.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, type MeshConfig } from "../src/config.js";
import type { Mesh } from "../src/mesh.js";
import { newMesh } from "./helpers.js";
import { a2a, a2aMessage, ACCESS_TOKEN, callback, CLIENT_SECRET, closeServers, fakeX, login, MCP_HEADERS, realFetch, serve, tool, xOAuth, type FakeX } from "./http-helpers.js";

const INVITE = "invite-token-9f2c1d7a-do-not-leak";
const NIL = "00000000-0000-4000-8000-000000000000";

let x: FakeX;
let errors: ReturnType<typeof vi.spyOn>;
/** Every response body the tests saw, to check afterwards that no secret was ever sent back. */
let seen: string[];

beforeEach(() => {
  x = fakeX();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  seen = [];
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeServers();
  const logged = JSON.stringify(errors.mock.calls.map((c: unknown[]) => c.map(String)));
  for (const secret of [INVITE, CLIENT_SECRET, ACCESS_TOKEN]) expect(logged).not.toContain(secret);
  expect(logged).not.toMatch(/xam_[A-Za-z0-9_-]{43}/); // no agent key is ever logged
  errors.mockRestore();
});

interface World {
  mesh: Mesh;
  base: string;
  call: (name: string, args?: Record<string, unknown>, opts?: { key?: string; headers?: Record<string, string> }) => ReturnType<typeof tool>;
  rpc: (method: string, params: unknown, opts?: { key?: string; headers?: Record<string, string> }) => ReturnType<typeof a2a>;
  /** Registers with the invite token; returns the key and verify_url. */
  join: (id: string, handle: string, extra?: Record<string, unknown>) => Promise<{ id: string; handle: string; key: string; verifyUrl?: string; body: any }>;
  /** Completes Sign in with X for `verifyUrl`, the fake X answering as (id, username). */
  signIn: (verifyUrl: string, id: string, username: string) => Promise<number>;
}

async function world(over: Partial<MeshConfig> = {}): Promise<World> {
  const mesh = newMesh({ adminToken: INVITE, requireVerified: true, xOAuth, ...over });
  const base = await serve(mesh);
  const call: World["call"] = async (name, args = {}, opts = {}) => {
    const r = await tool(base, name, args, opts);
    seen.push(JSON.stringify(r.body));
    return r;
  };
  const rpc: World["rpc"] = async (method, params, opts = {}) => {
    const r = await a2a(base, method, params, opts);
    seen.push(JSON.stringify(r));
    return r;
  };
  const join: World["join"] = async (id, handle, extra = {}) => {
    const r = await tool(base, "register_agent", { x_user_id: id, x_handle: handle, owner_opt_in: true, admin_token: INVITE, ...extra });
    if (r.isError) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
    return { id, handle, key: r.body.api_key, verifyUrl: r.body.verify_url, body: r.body };
  };
  const signIn: World["signIn"] = async (verifyUrl, id, username) => {
    x.me = { data: { id, username } };
    const l = await login(verifyUrl.replace("https://mesh.test", base));
    if (l.status !== 302) return l.status;
    return (await callback(base, { code: "code", state: l.state }, l.cookie)).status;
  };
  return { mesh, base, call, rpc, join, signIn };
}

/** alice (1) and bob (2), both verified; carol (3) registered but unverified. Alice and bob are mutuals. */
async function cast(w: World) {
  const alice = await w.join("1", "alice");
  const bob = await w.join("2", "bob");
  const carol = await w.join("3", "carol");
  expect(await w.signIn(alice.verifyUrl!, "1", "alice")).toBe(200);
  expect(await w.signIn(bob.verifyUrl!, "2", "bob")).toBe(200);
  return { alice, bob, carol };
}

const lists = (...ids: string[]) => ({ follower_ids: ids, following_ids: ids });

describe("agent API over HTTP: the whole journey on an invite-only, verified-only mesh", () => {
  it("register → verify with X → find mutuals → propose (MCP) → accept (A2A) → update → escalate → draft → complete", async () => {
    const w = await world();
    const { alice, bob, carol } = await cast(w);
    expect(alice.key).toMatch(/^xam_[A-Za-z0-9_-]{43}$/);
    expect(alice.body).toMatchObject({ x_user_id: "1", x_handle: "alice", rotated: false, x_verified: false });

    // Listing: only verified, opted-in mutuals; never the caller, never a non-mutual, never carol (unverified).
    const found = await w.call("list_mutual_agents", lists("2", "3", "999"), { key: alice.key });
    expect(found.isError).toBe(false);
    expect(found.body.mutual_count).toBe(3);
    expect(found.body.agents.map((a: any) => a.x_handle)).toEqual(["bob"]);
    expect(found.body.agents[0]).toMatchObject({ x_user_id: "2", x_verified: true, mesh_agent_card_url: "https://mesh.test/agents/bob/.well-known/agent-card.json" });
    expect(Object.keys(found.body.agents[0]).sort()).toEqual(["mesh_agent_card_url", "untrusted_agent_card_url", "untrusted_display_name", "x_handle", "x_user_id", "x_verified"]);

    const proposed = await w.call("propose_goal", { goal: "Record the podcast next week", participant_x_user_ids: ["2"] }, { key: alice.key });
    expect(proposed.isError).toBe(false);
    const threadId: string = proposed.body.thread.thread_id;
    expect(proposed.body.thread).toMatchObject({ status: "proposed", proposed_by_me: true, participants: ["1", "2"], accepted_by: ["1"], waiting_on: ["2"] });

    // Bob sees it over A2A and accepts there.
    const task = await w.rpc("tasks/get", { id: threadId }, { key: bob.key });
    expect(task.result).toMatchObject({ kind: "task", id: threadId, status: { state: "submitted" } });
    const accepted = await w.rpc("message/send", a2aMessage("ok", { taskId: threadId, metadata: { accept: true } }), { key: bob.key });
    expect(accepted.result.status.state).toBe("working");

    const update = await w.call("post_update", { thread_id: threadId, text: "Tuesday 3pm works", data: { slot: "2026-11-24T15:00Z" } }, { key: alice.key });
    expect(update.body.message).toMatchObject({ kind: "update", from_me: true, untrusted_text: "Tuesday 3pm works", untrusted_data: { slot: "2026-11-24T15:00Z" } });
    const esc = await w.call("escalate_to_human", { thread_id: threadId, question: "Is Tuesday ok?" }, { key: bob.key });
    expect(esc.body).toMatchObject({ ask_owner: "Is Tuesday ok?", sends_nothing: true, thread: { status: "input_required", needs_human: true } });
    const draft = await w.call("propose_payment", { thread_id: threadId, to_x_handle: "@alice", amount: 12.5, memo: "studio" }, { key: bob.key });
    expect(draft.body.draft).toMatchObject({ status: "draft", moves_money: false, to_x_user_id: "1", amount: 12.5, currency: "USD", untrusted_memo: "studio" });
    const done = await w.call("post_update", { thread_id: threadId, text: "Recorded.", set_status: "completed" }, { key: alice.key });
    expect(done.body.thread.status).toBe("completed");

    const read = await w.call("read_thread", { thread_id: threadId }, { key: bob.key });
    expect(read.body.messages.map((m: any) => m.kind)).toEqual(["proposal", "accept", "update", "escalation", "payment_draft", "status"]);
    const listed = await w.call("list_threads", { status: "completed" }, { key: alice.key });
    expect(listed.body.threads.map((t: any) => t.thread_id)).toEqual([threadId]);
    expect((await w.call("list_threads", { status: "active" }, { key: alice.key })).body.threads).toEqual([]);

    // Carol, registered but neither verified nor a participant, sees none of it.
    expect((await w.call("list_threads", {}, { key: carol.key })).body.threads).toEqual([]);
    expect((await w.call("read_thread", { thread_id: threadId }, { key: carol.key })).body.error).toBe("not_found");

    // Nothing the server ever sent back holds a key hash, the invite token, an X secret, or anyone's key
    // (each key appeared exactly once: in its own register_agent result, which is not in `seen`).
    const everything = seen.join("\n");
    for (const secret of [INVITE, CLIENT_SECRET, ACCESS_TOKEN, alice.key, bob.key, carol.key, "api_key_hash"]) expect(everything).not.toContain(secret);
    for (const a of [alice, bob, carol]) expect(everything).not.toContain((await w.mesh.store.getAgentByXUserId(a.id))!.api_key_hash);
  });
});

describe("authentication", () => {
  const TOOLS: [string, Record<string, unknown>][] = [
    ["start_x_verification", {}],
    ["list_mutual_agents", lists("2")],
    ["propose_goal", { goal: "g", participant_x_user_ids: ["2"] }],
    ["accept_goal", { thread_id: NIL, accept: true }],
    ["post_update", { thread_id: NIL, text: "t" }],
    ["list_threads", {}],
    ["read_thread", { thread_id: NIL }],
    ["escalate_to_human", { thread_id: NIL, question: "q" }],
    ["propose_payment", { thread_id: NIL, to_x_handle: "bob", amount: 1, memo: "" }],
  ];

  it("every tool but register_agent, and every A2A method, needs a valid agent key", async () => {
    const w = await world();
    for (const [name, args] of TOOLS) {
      const none = await w.call(name, args);
      expect(none.body.error, name).toBe("unauthorized");
      expect(none.body.message).toContain("Authorization: Bearer");
      const wrong = await w.call(name, args, { key: `xam_${"A".repeat(43)}` });
      expect(wrong.body, name).toEqual({ error: "unauthorized", message: "Unknown agent API key." });
    }
    for (const method of ["message/send", "tasks/get", "tasks/cancel", "message/stream", "tasks/pushNotificationConfig/get", "agent/getAuthenticatedExtendedCard", "no/such/method"]) {
      const r = await w.rpc(method, { id: NIL });
      expect(r.status, method).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe('Bearer realm="x-agent-mesh"');
      expect(r.error).toMatchObject({ code: -32010, message: "Unauthorized" });
    }
  });

  it("accepts only a Bearer credential, and nothing that merely resembles one", async () => {
    const w = await world();
    const alice = await w.join("1", "alice");
    const as = (authorization: string) => w.call("list_threads", {}, { headers: { Authorization: authorization } });
    for (const good of [`Bearer ${alice.key}`, `bearer ${alice.key}`, `BEARER   ${alice.key}  `]) expect((await as(good)).isError, good.slice(0, 8)).toBe(false);
    const hash = (await w.mesh.store.getAgentByXUserId("1"))!.api_key_hash!;
    for (const bad of [
      alice.key,
      `Basic ${Buffer.from(`alice:${alice.key}`).toString("base64")}`,
      `Token ${alice.key}`,
      `Bearer`,
      `Bearer ${alice.key} extra`,
      `Bearer ${alice.key.slice(0, -1)}`,
      `Bearer ${alice.key}x`,
      `Bearer ${alice.key.toUpperCase()}`,
      `Bearer ${hash}`, // the stored hash is not a credential
      `Bearer ${INVITE}`, // nor is the invite token
      `Bearer ${alice.id}`,
      `Bearer ${"k".repeat(8000)}`,
    ]) {
      expect((await as(bad)).body.error, bad.slice(0, 24)).toBe("unauthorized");
    }
    // The key is read from the Authorization header only: not from the query string, a cookie or the body.
    const res = await realFetch(`${w.base}/mcp?api_key=${alice.key}&access_token=${alice.key}`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Cookie: `api_key=${alice.key}; Authorization=Bearer ${alice.key}`, "X-Api-Key": alice.key },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_threads", arguments: { api_key: alice.key }, _meta: { authorization: `Bearer ${alice.key}` } } }),
    });
    expect(JSON.parse(((await res.json()) as any).result.content[0].text).error).toBe("unauthorized");
  });

  it("a rotated key stops working at once, on both surfaces", async () => {
    const w = await world();
    const alice = await w.join("1", "alice");
    const rotated = await w.call("register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true, admin_token: INVITE }, { key: alice.key });
    expect(rotated.body).toMatchObject({ rotated: true, x_user_id: "1" });
    expect(rotated.body.api_key).not.toBe(alice.key);
    expect((await w.call("list_threads", {}, { key: alice.key })).body.error).toBe("unauthorized");
    expect((await w.rpc("tasks/get", { id: NIL }, { key: alice.key })).status).toBe(401);
    expect((await w.call("list_threads", {}, { key: rotated.body.api_key })).isError).toBe(false);
  });

  it("one agent's key gives no access to another agent's threads, whatever ids it sends", async () => {
    const w = await world();
    const { alice, bob, carol } = await cast(w);
    expect(await w.signIn(carol.verifyUrl!, "3", "carol")).toBe(200);
    await w.call("list_mutual_agents", lists("2"), { key: alice.key });
    const threadId: string = (await w.call("propose_goal", { goal: "private", participant_x_user_ids: ["2"] }, { key: alice.key })).body.thread.thread_id;
    await w.call("accept_goal", { thread_id: threadId, accept: true }, { key: bob.key });

    for (const [name, args] of [
      ["read_thread", { thread_id: threadId }],
      ["accept_goal", { thread_id: threadId, accept: false }],
      ["post_update", { thread_id: threadId, text: "let me in" }],
      ["post_update", { thread_id: threadId, text: "close it", set_status: "completed" }],
      ["escalate_to_human", { thread_id: threadId, question: "?" }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "alice", amount: 1, memo: "" }],
    ] as const) {
      const r = await w.call(name, args, { key: carol.key });
      // Exactly what a thread that does not exist answers.
      expect(r.body, name).toEqual((await w.call(name, { ...args, thread_id: NIL }, { key: carol.key })).body);
      expect(r.body.error).toBe("not_found");
    }
    for (const [method, params] of [["tasks/get", { id: threadId }], ["tasks/cancel", { id: threadId }], ["message/send", a2aMessage("hi", { taskId: threadId })], ["message/send", a2aMessage("x", { contextId: threadId, metadata: { accept: false } })]] as const) {
      expect((await w.rpc(method, params, { key: carol.key })).error, method).toMatchObject({ code: -32001, message: "Task not found" });
    }
    expect((await w.call("list_threads", {}, { key: carol.key })).body.threads).toEqual([]);
    const intact = await w.call("read_thread", { thread_id: threadId }, { key: alice.key });
    expect(intact.body.thread.status).toBe("active");
    expect(intact.body.messages).toHaveLength(2);
    // from_x_user_id is the key's owner: a caller cannot post as someone else.
    await w.rpc("message/send", { message: { role: "agent", messageId: "spoof", taskId: threadId, parts: [{ kind: "text", text: "hello" }], metadata: { from_x_user_id: "1", from_x_handle: "alice" } }, metadata: { from_x_user_id: "1" } }, { key: bob.key });
    const last = (await w.call("read_thread", { thread_id: threadId }, { key: alice.key })).body.messages.at(-1);
    expect(last).toMatchObject({ from_x_user_id: "2", from_me: false, untrusted_text: "hello" });
  });
});

describe("the invite token (MESH_ADMIN_TOKEN)", () => {
  const args = (id: string, extra: Record<string, unknown> = {}) => ({ x_user_id: id, x_handle: `user_${id}`, owner_opt_in: true, ...extra });

  it("gates registration: missing, near-miss and mistyped tokens are all refused the same way", async () => {
    const w = await world();
    const none = await w.call("register_agent", args("1"));
    expect(none.body.error).toBe("forbidden");
    expect(none.body.message).toContain("invite-only");
    const guesses = [INVITE.slice(0, -1), `${INVITE}x`, ` ${INVITE}`, `${INVITE} `, INVITE.toUpperCase(), INVITE.slice(1), "x", "0", "null", "undefined", "true", "*", "%", `${INVITE}\u0000`, "a".repeat(512)];
    for (const guess of guesses) {
      const asArg = await w.call("register_agent", args("1", { admin_token: guess }));
      expect(asArg.body, guess.slice(0, 12)).toEqual({ error: "forbidden", message: "Invalid registration invite token." });
    }
    for (const guess of [INVITE.slice(0, -1), `${INVITE}x`, "x", "a".repeat(4000)]) {
      const asHeader = await w.call("register_agent", args("1"), { headers: { "X-Mesh-Admin-Token": guess } });
      expect(asHeader.body.error, guess.slice(0, 12)).toBe("forbidden");
    }
    // Wrong types never reach the comparison.
    for (const bad of [true, 1, null, ["a"], { $ne: "" }, ""]) expect((await w.call("register_agent", args("1", { admin_token: bad }))).isError, JSON.stringify(bad)).toBe(true);
    expect(await w.mesh.store.getAgentByXUserId("1")).toBeNull();

    // Either place works; a wrong one beside a right one does not spoil it.
    expect((await w.call("register_agent", args("1", { admin_token: INVITE }))).isError).toBe(false);
    expect((await w.call("register_agent", args("2"), { headers: { "X-Mesh-Admin-Token": INVITE } })).isError).toBe(false);
    expect((await w.call("register_agent", args("3", { admin_token: "wrong" }), { headers: { "X-Mesh-Admin-Token": INVITE } })).isError).toBe(false);
    // The token is never echoed, not even in a refusal or a validation error.
    const tooLong = await w.call("register_agent", args("4", { admin_token: `${INVITE}${"z".repeat(600)}` }));
    expect(tooLong.isError).toBe(true);
    expect(seen.join("\n")).not.toContain(INVITE);
  });

  it("is not a credential for anything else, and an agent key is not an invite", async () => {
    const w = await world();
    const alice = await w.join("1", "alice");
    const withToken = { headers: { "X-Mesh-Admin-Token": INVITE, Authorization: `Bearer ${INVITE}` } };
    expect((await w.call("list_threads", {}, withToken)).body.error).toBe("unauthorized");
    expect((await w.call("start_x_verification", {}, withToken)).body.error).toBe("unauthorized");
    expect((await w.rpc("tasks/get", { id: NIL }, withToken)).status).toBe(401);
    // A registered agent cannot register others without the token: its key is not one.
    expect((await w.call("register_agent", { x_user_id: "2", x_handle: "bob", owner_opt_in: true, admin_token: alice.key }, { key: alice.key })).body.error).toBe("forbidden");
    expect((await w.call("register_agent", { x_user_id: "2", x_handle: "bob", owner_opt_in: true }, { key: alice.key, headers: { "X-Mesh-Admin-Token": alice.key } })).body.error).toBe("forbidden");
    // Rotation needs both the token and the current key.
    expect((await w.call("register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true }, { key: alice.key })).body.error).toBe("forbidden");
    expect((await w.call("register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true, admin_token: INVITE })).body.error).toBe("forbidden");
    expect((await w.call("register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true, admin_token: INVITE }, { key: `xam_${"B".repeat(43)}` })).body.error).toBe("forbidden");
    expect((await w.call("list_threads", {}, { key: alice.key })).isError).toBe(false); // the key survived all of that
  });

  it("limits guesses per address, and a correct token does not get around the limit", async () => {
    let t = 1_800_000_000_000;
    const mesh = newMesh({ adminToken: INVITE, ipRate: { capacity: 5, refillPerSec: 20 / 3600 }, trustProxy: "fly" }, () => t);
    const base = await serve(mesh);
    const guess = (token: string, ip: string, id = "1") => tool(base, "register_agent", args(id, { admin_token: token }), { headers: { "Fly-Client-IP": ip } });
    for (let i = 0; i < 5; i++) expect((await guess(`guess-${i}`, "6.6.6.6")).body.error).toBe("forbidden");
    const limited = await guess(INVITE, "6.6.6.6");
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.body.retry_after_seconds).toBe(180);
    expect(await mesh.store.getAgentByXUserId("1")).toBeNull();
    // Another address is unaffected; the first recovers one attempt per 3 minutes.
    expect((await guess(INVITE, "7.7.7.7", "2")).isError).toBe(false);
    t += 180_000;
    expect((await guess(INVITE, "6.6.6.6")).isError).toBe(false);
    expect((await guess(INVITE, "6.6.6.6", "3")).body.error).toBe("rate_limited");
  });

  it("is reported by /healthz and the agent card as a mode, never as a value", async () => {
    const w = await world();
    const open = await serve(newMesh());
    expect(((await (await realFetch(`${open}/healthz`)).json()) as any).registration).toBe("open");
    for (const path of ["/healthz", "/.well-known/agent-card.json", "/nope", "/auth/x/login?ticket=x"]) {
      const text = await (await realFetch(`${w.base}${path}`, { headers: { "X-Mesh-Admin-Token": INVITE }, redirect: "manual" })).text();
      for (const secret of [INVITE, CLIENT_SECRET, xOAuth.clientId]) expect(text, path).not.toContain(secret);
    }
    expect(((await (await realFetch(`${w.base}/healthz`)).json()) as any)).toEqual({ ok: true, name: "x-agent-mesh", version: "0.1.0", store: "memory", require_verified: true, registration: "invite_only", x_oauth: "configured" });
  });
});

describe("registration", () => {
  it("validates every field and stores nothing on a refusal", async () => {
    const w = await world();
    const ok = { x_user_id: "10", x_handle: "dana", owner_opt_in: true, admin_token: INVITE };
    const bad: Record<string, unknown>[] = [
      { ...ok, x_user_id: 10 },
      { ...ok, x_user_id: "" },
      { ...ok, x_user_id: "-1" },
      { ...ok, x_user_id: "1e3" },
      { ...ok, x_user_id: "10 " },
      { ...ok, x_user_id: "10\n" },
      { ...ok, x_user_id: "１０" }, // full-width digits
      { ...ok, x_user_id: "1".repeat(21) },
      { ...ok, x_user_id: "10' or '1'='1" },
      { ...ok, x_handle: "" },
      { ...ok, x_handle: "@" },
      { ...ok, x_handle: "@@dana" },
      { ...ok, x_handle: "a".repeat(16) },
      { ...ok, x_handle: "da na" },
      { ...ok, x_handle: "dana;--" },
      { ...ok, x_handle: "dána" },
      { ...ok, x_handle: "dana‮" },
      { ...ok, x_handle: "<b>dana</b>" },
      { ...ok, owner_opt_in: false },
      { ...ok, owner_opt_in: "true" },
      { ...ok, owner_opt_in: 1 },
      { x_user_id: "10", x_handle: "dana", admin_token: INVITE },
      { ...ok, display_name: "" },
      { ...ok, display_name: "   " },
      { ...ok, display_name: "n".repeat(101) },
      { ...ok, display_name: 5 },
      { ...ok, agent_card_url: "http://example.com/card.json" },
      { ...ok, agent_card_url: "javascript:alert(1)" },
      { ...ok, agent_card_url: "data:text/html,<script>alert(1)</script>" },
      { ...ok, agent_card_url: "file:///etc/passwd" },
      { ...ok, agent_card_url: "//example.com/card.json" },
      { ...ok, agent_card_url: "https://" },
      { ...ok, agent_card_url: "https://user:pass@example.com/card.json" },
      { ...ok, agent_card_url: "https://example.com/a b" },
      { ...ok, agent_card_url: "https://example.com/‮card" },
      { ...ok, agent_card_url: `https://example.com/${"p".repeat(500)}` },
      { ...ok, agent_card_url: ["https://example.com"] },
    ];
    for (const args of bad) {
      const r = await w.call("register_agent", args);
      expect(r.isError, JSON.stringify(args).slice(0, 140)).toBe(true);
      expect(JSON.stringify(r.body)).not.toContain("xam_");
    }
    expect(await w.mesh.store.getAgentByXUserId("10")).toBeNull();
    expect(await w.mesh.store.getAgentByHandle("dana")).toBeNull();

    // Surrounding whitespace on the URL is trimmed by the schema, never stored.
    const good = await w.call("register_agent", { ...ok, x_handle: "@Dana_1", display_name: "Dana ‮<b>", agent_card_url: "  https://example.com/.well-known/agent-card.json?x=1#y " });
    expect(good.isError).toBe(false);
    expect(await w.mesh.store.getAgentByXUserId("10")).toMatchObject({ x_handle: "Dana_1", display_name: "Dana <b>", agent_card_url: "https://example.com/.well-known/agent-card.json?x=1#y", x_verified: false, owner_opt_in: true });
  });

  it("ignores fields a caller has no business setting: nobody registers as verified", async () => {
    const w = await world();
    const r = await w.call("register_agent", { x_user_id: "10", x_handle: "dana", owner_opt_in: true, admin_token: INVITE, x_verified: true, id: NIL, api_key_hash: "0".repeat(64), api_key: "xam_chosen", created_at: "2000-01-01T00:00:00Z", opted_in_at: "2000-01-01T00:00:00Z" });
    expect(r.isError).toBe(false);
    expect(r.body.x_verified).toBe(false);
    expect(r.body.api_key).not.toBe("xam_chosen");
    const row = (await w.mesh.store.getAgentByXUserId("10"))!;
    expect(row.x_verified).toBe(false);
    expect(row.id).not.toBe(NIL);
    expect(row.api_key_hash).not.toBe("0".repeat(64));
    expect(row.opted_in_at).not.toBe("2000-01-01T00:00:00Z");
    expect((await w.call("list_threads", {}, { key: "xam_chosen" })).body.error).toBe("unauthorized");
  });

  it("one agent per X account and per handle; taking over either needs the current key", async () => {
    const w = await world();
    const alice = await w.join("1", "alice");
    const again = await w.call("register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true, admin_token: INVITE });
    expect(again.body.error).toBe("forbidden");
    const steal = await w.call("register_agent", { x_user_id: "1", x_handle: "mallory", owner_opt_in: true, admin_token: INVITE }, { key: `xam_${"C".repeat(43)}` });
    expect(steal.body.error).toBe("forbidden");
    for (const handle of ["alice", "ALICE", "@Alice"]) {
      const squat = await w.call("register_agent", { x_user_id: "2", x_handle: handle, owner_opt_in: true, admin_token: INVITE });
      expect(squat.body.error, handle).toBe("conflict");
    }
    // Another agent's key does not help.
    const bob = await w.join("2", "bob");
    expect((await w.call("register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true, admin_token: INVITE }, { key: bob.key })).body.error).toBe("forbidden");
    expect((await w.call("register_agent", { x_user_id: "2", x_handle: "alice", owner_opt_in: true, admin_token: INVITE }, { key: bob.key })).body.error).toBe("conflict");
    expect((await w.mesh.store.getAgentByXUserId("1"))!.x_handle).toBe("alice");
    expect((await w.call("list_threads", {}, { key: alice.key })).isError).toBe(false);
  });
});

describe("listing mutuals", () => {
  it("validates the id lists", async () => {
    const w = await world();
    const { alice } = await cast(w);
    const tooMany = Array.from({ length: LIMITS.ids + 1 }, (_, i) => String(i + 100));
    for (const args of [{}, { follower_ids: ["2"] }, { following_ids: ["2"] }, { follower_ids: "2", following_ids: "2" }, lists("2", "x"), lists("2", ""), { follower_ids: [2], following_ids: [2] }, { follower_ids: [["2"]], following_ids: ["2"] }, { follower_ids: tooMany, following_ids: ["2"] }, { follower_ids: ["2"], following_ids: tooMany }, lists("2' or 1=1 --")]) {
      const r = await w.call("list_mutual_agents", args, { key: alice.key });
      expect(r.isError, JSON.stringify(args).slice(0, 80)).toBe(true);
    }
    const empty = await w.call("list_mutual_agents", { follower_ids: [], following_ids: [] }, { key: alice.key });
    expect(empty.body).toMatchObject({ mutual_count: 0, agents: [], require_verified: true });
  });

  it("returns an agent only if both lists name it, it opted in, and (on this mesh) it is verified", async () => {
    const w = await world();
    const { alice, bob, carol } = await cast(w);
    const handles = async (args: Record<string, unknown>, key = alice.key) => ((await w.call("list_mutual_agents", args, { key })).body.agents as any[]).map((a) => a.x_handle);
    expect(await handles({ follower_ids: ["2"], following_ids: ["3"] })).toEqual([]); // follows one way only
    expect(await handles(lists("1"))).toEqual([]); // never yourself
    expect(await handles(lists("1", "2", "3", "2", "2"))).toEqual(["bob"]);
    // Carol appears once she has signed in with X...
    expect(await w.signIn(carol.verifyUrl!, "3", "carol")).toBe(200);
    expect((await handles(lists("2", "3"))).sort()).toEqual(["bob", "carol"]);
    // ...and bob disappears when his owner opts out.
    await w.mesh.store.updateAgent("2", { owner_opt_in: false });
    expect(await handles(lists("2", "3"))).toEqual(["carol"]);
    void bob;
  });

  it("shows an unverified caller nobody on a verified-only mesh, and says why", async () => {
    const w = await world();
    const { alice } = await cast(w);
    const dave = await w.join("4", "dave");
    const blind = await w.call("list_mutual_agents", lists("1", "2"), { key: dave.key });
    expect(blind.isError).toBe(false);
    expect(blind.body).toMatchObject({ mutual_count: 2, agents: [], require_verified: true });
    expect(blind.body.verification_required).toContain("start_x_verification");
    expect(JSON.stringify(blind.body)).not.toContain("alice");
    // A verified caller gets no such note; and once dave verifies, the set he supplied is still remembered.
    expect((await w.call("list_mutual_agents", lists("2"), { key: alice.key })).body.verification_required).toBeUndefined();
    expect(await w.signIn(dave.verifyUrl!, "4", "dave")).toBe(200);
    expect((await w.call("propose_goal", { goal: "g", participant_x_user_ids: ["1"] }, { key: dave.key })).isError).toBe(false);
    expect(((await w.call("list_mutual_agents", lists("1", "2"), { key: dave.key })).body.agents as any[]).map((a) => a.x_handle).sort()).toEqual(["alice", "bob"]);
  });

  it("without MESH_REQUIRE_VERIFIED, unverified agents are listed but flagged", async () => {
    const w = await world({ requireVerified: false });
    const alice = await w.join("1", "alice");
    await w.join("2", "bob");
    const r = await w.call("list_mutual_agents", lists("2"), { key: alice.key });
    expect(r.body.require_verified).toBe(false);
    expect(r.body.agents).toHaveLength(1);
    expect(r.body.agents[0]).toMatchObject({ x_handle: "bob", x_verified: false });
    expect(r.body.agents[0].verification).toContain("UNVERIFIED");
  });
});

describe("proposals", () => {
  it("validates the goal, the participants and the lists", async () => {
    const w = await world();
    const { alice } = await cast(w);
    await w.call("list_mutual_agents", lists("2"), { key: alice.key });
    const ok = { goal: "g", participant_x_user_ids: ["2"] };
    const bad: Record<string, unknown>[] = [
      {},
      { goal: "g" },
      { participant_x_user_ids: ["2"] },
      { ...ok, goal: "" },
      { ...ok, goal: "  \n\t " },
      { ...ok, goal: "g".repeat(LIMITS.goal + 1) },
      { ...ok, goal: ["g"] },
      { ...ok, participant_x_user_ids: [] },
      { ...ok, participant_x_user_ids: "2" },
      { ...ok, participant_x_user_ids: ["bob"] },
      { ...ok, participant_x_user_ids: [2] },
      { ...ok, participant_x_user_ids: Array.from({ length: LIMITS.participants + 1 }, (_, i) => String(i + 50)) },
      { ...ok, participant_x_user_ids: ["1"] }, // only yourself
      { ...ok, follower_ids: ["2"] }, // one list without the other
      { ...ok, following_ids: ["2"] },
      { ...ok, follower_ids: ["x"], following_ids: ["2"] },
    ];
    for (const args of bad) {
      const r = await w.call("propose_goal", args, { key: alice.key });
      expect(r.isError, JSON.stringify(args).slice(0, 100)).toBe(true);
    }
    expect((await w.call("list_threads", {}, { key: alice.key })).body.threads).toEqual([]);
    const good = await w.call("propose_goal", { goal: "g".repeat(LIMITS.goal), participant_x_user_ids: ["2", "2", "1"] }, { key: alice.key });
    expect(good.isError).toBe(false);
    expect(good.body.thread.participants).toEqual(["1", "2"]);
  });

  it("go only to mutuals who are registered, opted in and verified", async () => {
    const w = await world();
    const { alice, carol } = await cast(w);
    const propose = (ids: string[], extra: Record<string, unknown> = {}, key = alice.key) => w.call("propose_goal", { goal: "g", participant_x_user_ids: ids, ...extra }, { key });
    // No mutual set on record yet.
    const cold = await propose(["2"]);
    expect(cold.body.error).toBe("forbidden");
    expect(cold.body.message).toContain("list_mutual_agents");
    await w.call("list_mutual_agents", lists("2", "3", "999"), { key: alice.key });
    expect((await propose(["5"])).body.message).toContain("Not among your mutuals"); // not a mutual
    expect((await propose(["999"])).body.message).toContain("Not registered"); // a mutual with no agent
    const unverified = await propose(["3"]); // carol: registered, not verified
    expect(unverified.body.error).toBe("forbidden");
    expect(unverified.body.message).toContain("verified");
    expect((await propose(["2", "3"])).body.error).toBe("forbidden"); // one bad participant spoils the proposal
    // Lists passed inline replace the remembered set.
    expect((await propose(["2"], lists("3"))).body.error).toBe("forbidden");
    expect((await propose(["2"])).body.error).toBe("forbidden");
    expect((await propose(["2"], lists("2"))).isError).toBe(false);
    // The same rules over A2A.
    expect((await w.rpc("message/send", a2aMessage("g", { metadata: { to_x_user_id: "3" } }), { key: alice.key })).error).toMatchObject({ code: -32011, message: "Forbidden" });
    expect((await w.rpc("message/send", a2aMessage("g", { metadata: { to_x_user_ids: ["2"] } }), { key: alice.key })).result.status.state).toBe("submitted");
    expect((await w.call("list_threads", {}, { key: carol.key })).body.threads).toEqual([]);
  });

  it("an unverified agent cannot propose on either surface, and is told how to verify", async () => {
    const w = await world();
    const { carol } = await cast(w);
    const viaMcp = await w.call("propose_goal", { goal: "g", participant_x_user_ids: ["2"], ...lists("2") }, { key: carol.key });
    expect(viaMcp.body.error).toBe("forbidden");
    expect(viaMcp.body.message).toContain("start_x_verification");
    const viaA2a = await w.rpc("message/send", a2aMessage("g", { metadata: { to_x_user_id: "2" } }), { key: carol.key });
    expect(viaA2a.error).toMatchObject({ code: -32011 });
    expect((await w.call("list_threads", {}, { key: (await w.join("9", "erin")).key })).body.threads).toEqual([]);
    // Its card is hidden too.
    expect((await realFetch(`${w.base}/agents/carol/.well-known/agent-card.json`)).status).toBe(404);
    expect((await realFetch(`${w.base}/agents/bob/.well-known/agent-card.json`)).status).toBe(200);

    // After signing in with X as the registered account, it can.
    expect(await w.signIn(carol.verifyUrl!, "3", "carol")).toBe(200);
    expect((await w.call("propose_goal", { goal: "g", participant_x_user_ids: ["2"], ...lists("2") }, { key: carol.key })).isError).toBe(false);
  });

  it("verification cannot be obtained by signing in as a different X account, and is lost on a handle change", async () => {
    const w = await world();
    const { alice, bob, carol } = await cast(w);
    // Carol's owner signs in as some other account: still unverified.
    expect(await w.signIn(carol.verifyUrl!, "666", "mallory")).toBe(403);
    expect((await w.mesh.store.getAgentByXUserId("3"))!.x_verified).toBe(false);
    // Alice's link (already used) cannot verify carol, nor can carol's link be finished as alice.
    expect(await w.signIn(alice.verifyUrl!, "3", "carol")).toBe(400);
    expect(await w.signIn(carol.verifyUrl!, "1", "alice")).toBe(403);
    expect((await w.mesh.store.getAgentByXUserId("3"))!.x_verified).toBe(false);

    // Bob re-registers under a new handle with his key: only the old handle was proven, so he is unverified again.
    const renamed = await w.call("register_agent", { x_user_id: "2", x_handle: "bobby", owner_opt_in: true, admin_token: INVITE }, { key: bob.key });
    expect(renamed.body).toMatchObject({ rotated: true, x_verified: false });
    expect(renamed.body.verify_url).toContain("/auth/x/login?ticket=");
    const found = await w.call("list_mutual_agents", lists("2"), { key: alice.key });
    expect(found.body.agents).toEqual([]);
    expect((await w.call("propose_goal", { goal: "g", participant_x_user_ids: ["2"] }, { key: alice.key })).body.error).toBe("forbidden");
    expect((await w.call("propose_goal", { goal: "g", participant_x_user_ids: ["1"], ...lists("1") }, { key: renamed.body.api_key })).body.error).toBe("forbidden");
  });

  it("validates the thread tools' arguments", async () => {
    const w = await world();
    const { alice, bob } = await cast(w);
    await w.call("list_mutual_agents", lists("2"), { key: alice.key });
    const threadId: string = (await w.call("propose_goal", { goal: "g", participant_x_user_ids: ["2"] }, { key: alice.key })).body.thread.thread_id;
    await w.call("accept_goal", { thread_id: threadId, accept: true }, { key: bob.key });
    const cases: [string, Record<string, unknown>][] = [
      ["accept_goal", { thread_id: threadId }],
      ["accept_goal", { thread_id: threadId, accept: "yes" }],
      ["accept_goal", { thread_id: "1", accept: true }],
      ["accept_goal", { thread_id: `${threadId}' or '1'='1`, accept: true }],
      ["post_update", { thread_id: threadId }],
      ["post_update", { thread_id: threadId, text: "" }],
      ["post_update", { thread_id: threadId, text: "   " }],
      ["post_update", { thread_id: threadId, text: "t".repeat(LIMITS.text + 1) }],
      ["post_update", { thread_id: threadId, text: "t", data: "string" }],
      ["post_update", { thread_id: threadId, text: "t", data: ["array"] }],
      ["post_update", { thread_id: threadId, text: "t", data: { blob: "b".repeat(LIMITS.dataBytes) } }],
      ["post_update", { thread_id: threadId, text: "t", set_status: "canceled" }],
      ["post_update", { thread_id: threadId, text: "t", set_status: "proposed" }],
      ["post_update", { thread_id: threadId, text: "t", needs_human: "true" }],
      ["post_update", { thread_id: threadId, text: "t", needs_human: true, set_status: "completed" }],
      ["list_threads", { status: "everything" }],
      ["list_threads", { status: ["active"] }],
      ["read_thread", {}],
      ["read_thread", { thread_id: threadId, limit: 0 }],
      ["read_thread", { thread_id: threadId, limit: LIMITS.readMax + 1 }],
      ["read_thread", { thread_id: threadId, limit: 1.5 }],
      ["read_thread", { thread_id: threadId, limit: "10" }],
      ["escalate_to_human", { thread_id: threadId }],
      ["escalate_to_human", { thread_id: threadId, question: "" }],
      ["escalate_to_human", { thread_id: threadId, question: "q".repeat(LIMITS.question + 1) }],
      ["escalate_to_human", { thread_id: threadId, question: "q", context: "c".repeat(2001) }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: 0, memo: "" }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: -5, memo: "" }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: 1_000_001, memo: "" }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: "5", memo: "" }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: 1e400, memo: "" }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: 5, currency: "usd", memo: "" }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: 5, currency: "DOLLARS", memo: "" }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: 5, memo: "m".repeat(LIMITS.memo + 1) }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: 5 }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "not a handle", amount: 5, memo: "" }],
      ["propose_payment", { thread_id: threadId, to_x_handle: "alice", amount: 5, memo: "" }], // yourself
      ["propose_payment", { thread_id: threadId, to_x_handle: "carol", amount: 5, memo: "" }], // not in the thread
    ];
    for (const [name, args] of cases) {
      const r = await w.call(name, args, { key: alice.key });
      expect(r.isError, `${name} ${JSON.stringify(args).slice(0, 100)}`).toBe(true);
      expect(r.body.error ?? "validation").not.toBe("internal");
    }
    const read = await w.call("read_thread", { thread_id: threadId, limit: LIMITS.readMax }, { key: alice.key });
    expect(read.body.thread.status).toBe("active");
    expect(read.body.messages.map((m: any) => m.kind)).toEqual(["proposal", "accept"]); // none of the above stored anything
    expect(errors).not.toHaveBeenCalled();
  });

  it("an unknown tool or a non-tool method is an error, not a crash", async () => {
    const w = await world();
    const unknown = await w.call("delete_everything", {});
    expect(unknown.isError).toBe(true);
    const post = async (body: unknown) => {
      const res = await realFetch(`${w.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });
      return { status: res.status, text: await res.text() };
    };
    const noMethod = await post({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "file:///etc/passwd" } });
    expect(noMethod.text).toContain("error");
    expect(noMethod.text).not.toContain("root:");
    expect((await post({ hello: "world" })).status).toBeGreaterThanOrEqual(400);
    expect((await post([])).status).toBeLessThan(500); // an empty batch is a no-op for the SDK
    expect((await post("just a string")).status).toBeLessThan(500);
    expect(errors).not.toHaveBeenCalled();
    expect((await realFetch(`${w.base}/healthz`)).status).toBe(200);
  });
});
