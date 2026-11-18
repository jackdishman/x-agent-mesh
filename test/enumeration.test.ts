// Limits on finding out who is registered: agent-card lookups by handle (per address), and
// probing through self-reported mutual lists (per agent and per address). The documented flows
// (list your mutuals, propose to them, fetch a mutual's card) must keep working within them, and
// the answers must not tell "unknown" apart from "not for you".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleA2A } from "../src/a2a.js";
import { LIMITS, loadConfig, type MeshConfig } from "../src/config.js";
import { call, newMesh, register, trio } from "./helpers.js";
import { closeServers, realFetch, serve, tool, xOAuth } from "./http-helpers.js";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await closeServers();
  expect(errors.mock.calls).toEqual([]);
  errors.mockRestore();
});

const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(from + i));
const lists = (list: string[]) => ({ follower_ids: list, following_ids: list });
const perDay = (n: number) => ({ capacity: n, refillPerSec: n / 86_400 });
const card = (base: string, handle: string, headers: Record<string, string> = {}) => realFetch(`${base}/agents/${handle}/.well-known/agent-card.json`, { headers });

describe("agent cards by handle: per-address lookup limit", () => {
  it("answers 429 with Retry-After once an address has asked about too many handles, found or not", async () => {
    let t = 1_800_000_000_000;
    const mesh = newMesh({ cardRate: { capacity: 5, refillPerSec: 1 / 60 } }, () => t);
    const base = await serve(mesh);
    await register(mesh, "1", "alice");
    const statuses: number[] = [];
    for (const h of ["alice", "nobody1", "nobody2", "bad-handle!", "alice"]) statuses.push((await card(base, h)).status);
    expect(statuses).toEqual([200, 404, 404, 404, 200]);
    const limited = await card(base, "alice");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await limited.json()) as any;
    expect(body).toMatchObject({ error: "rate_limited", retry_after_seconds: expect.any(Number) });
    expect(JSON.stringify(body)).not.toContain("alice"); // a limited answer says nothing about the handle
    expect((await card(base, "nobody3")).status).toBe(429);
    // It refills, and only this route is affected.
    expect((await realFetch(`${base}/.well-known/agent-card.json`)).status).toBe(200);
    expect((await realFetch(`${base}/healthz`)).status).toBe(200);
    expect((await tool(base, "register_agent", { x_user_id: "2", x_handle: "bob", owner_opt_in: true })).isError).toBe(false);
    t += 61_000;
    expect((await card(base, "bob")).status).toBe(200);
    expect((await card(base, "bob")).status).toBe(429);
  });

  it("is per address: one client's lookups do not use up another's", async () => {
    const mesh = newMesh({ cardRate: { capacity: 2, refillPerSec: 0.0001 }, trustProxy: true });
    const base = await serve(mesh);
    await register(mesh, "1", "alice");
    const from = (ip: string) => card(base, "alice", { "X-Forwarded-For": ip });
    expect([(await from("203.0.113.1")).status, (await from("203.0.113.1")).status, (await from("203.0.113.1")).status]).toEqual([200, 200, 429]);
    expect((await from("203.0.113.2")).status).toBe(200);
    // One IPv6 /64 is one client.
    expect([(await from("2001:db8::1")).status, (await from("2001:db8::2")).status, (await from("2001:db8::3")).status]).toEqual([200, 200, 429]);
  });

  it("gives one identical answer for every handle that has no card to show", async () => {
    const mesh = newMesh({ requireVerified: true, xOAuth });
    const base = await serve(mesh);
    await register(mesh, "1", "verified_one");
    await mesh.store.updateAgent("1", { x_verified: true });
    await register(mesh, "2", "unverified"); // registered, but hidden on a verified-only mesh
    await register(mesh, "3", "opted_out");
    await mesh.store.updateAgent("3", { x_verified: true, owner_opt_in: false });
    expect((await card(base, "verified_one")).status).toBe(200);
    const answers = new Set<string>();
    for (const h of ["unverified", "opted_out", "never_seen", "UNVERIFIED", "@opted_out", "way_too_long_to_be_a_handle", "bad!", "%E0%A4%A", "a%00b", "..%2F..%2Fetc"]) {
      const res = await card(base, h);
      expect(res.status, h).toBe(404);
      const headers = [...res.headers].filter(([k]) => !["date", "keep-alive", "connection"].includes(k)).map(([k, v]) => `${k}: ${v}`).sort().join("\n");
      answers.add(`${headers}\n\n${await res.text()}`);
    }
    expect(answers.size).toBe(1);
    expect([...answers][0]).toContain('{"error":"not_found","message":"No registered, opted-in agent with that handle."}');
  });

  it("has sane defaults and reads MESH_CARD_BURST / MESH_CARD_PER_HOUR", () => {
    expect(loadConfig({}).cardRate).toEqual({ capacity: 60, refillPerSec: 600 / 3600 });
    expect(loadConfig({ MESH_CARD_BURST: "10", MESH_CARD_PER_HOUR: "36" }).cardRate).toEqual({ capacity: 10, refillPerSec: 0.01 });
    expect(() => loadConfig({ MESH_CARD_BURST: "0" })).toThrow(/MESH_CARD_BURST/);
    // The per-address request limit still sits in front of it.
    expect(loadConfig({}).httpRate.capacity).toBeGreaterThan(loadConfig({}).cardRate.capacity);
  });
});

describe("mutual lists: budget of new ids per agent", () => {
  const budget = (n: number, over: Partial<MeshConfig> = {}) => ({ mutualRate: perDay(n), ...over });

  it("charges only ids that were not in the list supplied last: repeating a real list is free", async () => {
    const mesh = newMesh(budget(1000));
    const { alice } = await trio(mesh); // trio() already supplied ["2", "3"]: 2 ids
    const mine = ["2", "3", ...ids(1000, 498)]; // 498 new
    for (let i = 0; i < 50; i++) {
      const r = await call(mesh, alice.ctx, "list_mutual_agents", lists(mine));
      expect(r.isError).toBe(false);
      expect(r.body.agents.map((a: any) => a.x_user_id).sort()).toEqual(["2", "3"]);
    }
    // A real list changes a little from day to day: that costs a little.
    const nextDay = [...mine.slice(0, -5), ...ids(5000, 10)]; // five unfollowed, ten new
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(nextDay))).isError).toBe(false);
    // Proposing to remembered mutuals, with or without re-sending the lists, costs nothing.
    for (let i = 0; i < 20; i++) expect((await call(mesh, alice.ctx, "propose_goal", { goal: `g${i}`, participant_x_user_ids: ["2"], ...(i % 2 ? lists(nextDay) : {}) })).isError).toBe(false);
    // 2 + 498 + 10 = 510 of 1000 used: 490 more new ids fit, 491 do not.
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(ids(20_000, 491)))).body.error).toBe("rate_limited");
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(ids(20_000, 490)))).isError).toBe(false);
  });

  it("stops an agent walking through other people's ids, with a clear error, and changes nothing when it refuses", async () => {
    let t = 1_800_000_000_000;
    const mesh = newMesh(budget(10_000), () => t);
    const { alice, bob } = await trio(mesh);
    // Mallory-style probing: a fresh block of ids each call, to learn which have agents.
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(ids(100_000, 5000)))).isError).toBe(false);
    const kept = ["2", ...ids(200_000, 4000)];
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(kept))).isError).toBe(false); // 9003 used
    const refused = await call(mesh, alice.ctx, "list_mutual_agents", lists(["3", ...ids(300_000, 4000)]));
    expect(refused.body).toEqual({
      error: "rate_limited",
      message: expect.stringMatching(/checked as many new X ids for agents as it may for now\. Wait \d+ seconds .* re-sending it costs nothing\. Do not retry in a loop\.$/),
      retry_after_seconds: expect.any(Number),
    });
    expect(refused.body.agents).toBeUndefined(); // nothing about who is registered
    expect(JSON.stringify(refused.body)).not.toContain("carol");
    // The refused list was not remembered: the last accepted one still stands.
    expect((await call(mesh, alice.ctx, "propose_goal", { goal: "to bob", participant_x_user_ids: ["2"] })).isError).toBe(false);
    expect((await call(mesh, alice.ctx, "propose_goal", { goal: "to carol", participant_x_user_ids: ["3"] })).body.message).toContain("Not among your mutuals");
    // propose_goal with fresh lists is the same probe and is charged the same way; no thread is made.
    const viaPropose = await call(mesh, alice.ctx, "propose_goal", { goal: "probe", participant_x_user_ids: ["3"], ...lists(["3", ...ids(400_000, 4000)]) });
    expect(viaPropose.body.error).toBe("rate_limited");
    expect((await call(mesh, alice.ctx, "list_threads")).body.threads.map((x: any) => x.untrusted_goal)).toEqual(["to bob"]);
    // Other agents are unaffected, and so is everything else alice does.
    expect((await call(mesh, bob.ctx, "list_mutual_agents", lists(ids(500_000, 5000)))).isError).toBe(false);
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(kept))).isError).toBe(false);
    // The budget refills over the day.
    t += Math.min(refused.body.retry_after_seconds, 86_400) * 1000;
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(["3", ...ids(300_000, 4000)]))).isError).toBe(false);
  });

  it("a list remembered too long ago (or evicted) is charged in full again", async () => {
    let t = 1_800_000_000_000;
    const mesh = newMesh({ mutualRate: perDay(10_000), mutualTtlMs: 3_600_000 }, () => t);
    const alice = await register(mesh, "1", "alice");
    const mine = ids(1000, 6000);
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(mine))).isError).toBe(false);
    t += 3_700_000; // past the TTL: the server no longer holds the set, so it cannot tell these are not new
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(mine))).body.error).toBe("rate_limited"); // 6000 + 6000 > 10,000 + an hour's refill
    t += 12 * 3_600_000;
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(mine))).isError).toBe(false);
  });

  it("is also bounded per address, across the agents calling from it", async () => {
    const mesh = newMesh({ mutualRate: perDay(10_000), mutualIpRate: perDay(15_000) });
    const a = await register(mesh, "1", "alice");
    const b = await register(mesh, "2", "bob");
    const c = await register(mesh, "3", "carol");
    const shared = "198.51.100.7";
    const as = (who: typeof a, ip: string) => ({ ...who.ctx, ip });
    expect((await call(mesh, as(a, shared), "list_mutual_agents", lists(ids(10_000, 8000)))).isError).toBe(false);
    expect((await call(mesh, as(b, shared), "list_mutual_agents", lists(ids(20_000, 6000)))).isError).toBe(false); // 14,000 from this address
    // Carol has her whole own budget left, but the address has not.
    const refused = await call(mesh, as(c, shared), "list_mutual_agents", lists(ids(30_000, 5000)));
    expect(refused.body.error).toBe("rate_limited");
    // From another address she is fine.
    expect((await call(mesh, as(c, "198.51.100.8"), "list_mutual_agents", lists(ids(30_000, 5000)))).isError).toBe(false);
  });

  it("a full 10,000-id list always fits a fresh budget, whatever the configured numbers", async () => {
    const cfg = loadConfig({ MESH_MUTUAL_IDS_PER_DAY: "1", MESH_MUTUAL_IDS_PER_DAY_PER_IP: "1" });
    expect(cfg.mutualRate.capacity).toBe(LIMITS.ids);
    expect(cfg.mutualIpRate.capacity).toBe(LIMITS.ids);
    const mesh = newMesh({ mutualRate: cfg.mutualRate, mutualIpRate: cfg.mutualIpRate });
    const alice = await register(mesh, "1", "alice");
    const r = await call(mesh, alice.ctx, "list_mutual_agents", lists(ids(1000, LIMITS.ids)));
    expect(r.isError).toBe(false);
    expect(r.body.mutual_count).toBe(LIMITS.ids);
  });

  it("defaults: 30,000 new ids a day per agent, 300,000 per address; the per-address budget is never below the per-agent one", () => {
    const d = loadConfig({});
    expect(d.mutualRate).toEqual({ capacity: 30_000, refillPerSec: 30_000 / 86_400 });
    expect(d.mutualIpRate).toEqual({ capacity: 300_000, refillPerSec: 300_000 / 86_400 });
    const c = loadConfig({ MESH_MUTUAL_IDS_PER_DAY: "50000", MESH_MUTUAL_IDS_PER_DAY_PER_IP: "20000" });
    expect(c.mutualRate.capacity).toBe(50_000);
    expect(c.mutualIpRate.capacity).toBe(50_000);
    expect(() => loadConfig({ MESH_MUTUAL_IDS_PER_DAY: "many" })).toThrow(/MESH_MUTUAL_IDS_PER_DAY/);
  });

  it("the documented journey fits the default budgets many times over", async () => {
    const d = loadConfig({});
    const mesh = newMesh({ mutualRate: d.mutualRate, mutualIpRate: d.mutualIpRate, cardRate: d.cardRate });
    const base = await serve(mesh);
    const { alice, bob } = await trio(mesh);
    const mine = ["2", "3", ...ids(1000, 3000)];
    for (let day = 0; day < 10; day++) {
      const r = await call(mesh, alice.ctx, "list_mutual_agents", lists(mine));
      expect(r.isError).toBe(false);
      for (const a of r.body.agents) expect((await realFetch(a.mesh_agent_card_url.replace("https://mesh.test", base))).status).toBe(200);
      const p = await call(mesh, alice.ctx, "propose_goal", { goal: `day ${day}`, participant_x_user_ids: ["2"] });
      expect(p.isError).toBe(false);
      expect((await call(mesh, bob.ctx, "accept_goal", { thread_id: p.body.thread.thread_id, accept: true })).isError).toBe(false);
    }
  });
});

describe("uniform answers: 'does not exist' and 'not yours' look the same", () => {
  it("threads: read, accept, post, payment and A2A get / cancel / send", async () => {
    const mesh = newMesh();
    const { alice, bob, carol } = await trio(mesh);
    const real = (await call(mesh, alice.ctx, "propose_goal", { goal: "private", participant_x_user_ids: ["2"] })).body.thread.thread_id as string;
    await call(mesh, bob.ctx, "accept_goal", { thread_id: real, accept: true });
    const none = "00000000-0000-4000-8000-000000000000";
    const tools: [string, (id: string) => Record<string, unknown>][] = [
      ["read_thread", (id) => ({ thread_id: id })],
      ["accept_goal", (id) => ({ thread_id: id, accept: true })],
      ["post_update", (id) => ({ thread_id: id, text: "hi" })],
      ["escalate_to_human", (id) => ({ thread_id: id, question: "q" })],
      ["propose_payment", (id) => ({ thread_id: id, to_x_handle: "alice", amount: 1, memo: "" })],
    ];
    for (const [name, args] of tools) {
      const foreign = await call(mesh, carol.ctx, name, args(real));
      const missing = await call(mesh, carol.ctx, name, args(none));
      expect(foreign.body, name).toEqual({ error: "not_found", message: "No such thread, or you are not a participant in it." });
      expect(missing.body, name).toEqual(foreign.body);
    }
    const rpc = async (method: string, params: (id: string) => unknown) => {
      const [foreign, missing] = await Promise.all([real, none].map((id) => handleA2A(mesh, carol.ctx, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params(id) }))));
      expect(foreign!.status).toBe(200);
      expect((foreign!.body as any).error.code, method).toBe(-32001);
      expect(missing).toEqual(foreign);
    };
    await rpc("tasks/get", (id) => ({ id }));
    await rpc("tasks/cancel", (id) => ({ id }));
    await rpc("message/send", (id) => ({ message: { role: "agent", messageId: "m", taskId: id, parts: [{ kind: "text", text: "hi" }] } }));
    // Nothing leaked into carol's own view, and the thread is untouched.
    expect((await call(mesh, carol.ctx, "list_threads")).body.threads).toEqual([]);
    expect((await mesh.store.getThread(real))!.status).toBe("active");
    expect(await mesh.store.listMessages(real, 50)).toHaveLength(2);
  });

  it("payment drafts: an unregistered handle and a registered non-participant get the same refusal", async () => {
    const mesh = newMesh();
    const { alice, bob } = await trio(mesh);
    const threadId = (await call(mesh, alice.ctx, "propose_goal", { goal: "g", participant_x_user_ids: ["2"] })).body.thread.thread_id as string;
    await call(mesh, bob.ctx, "accept_goal", { thread_id: threadId, accept: true });
    const pay = (to: string) => call(mesh, alice.ctx, "propose_payment", { thread_id: threadId, to_x_handle: to, amount: 1, memo: "" });
    const registered = await pay("carol"); // exists, but is not in this thread
    const unknown = await pay("nobody_here");
    const self = await pay("alice");
    expect(registered.body).toEqual({ error: "forbidden", message: "Payment drafts can only name another participant of this thread as the payee." });
    expect(unknown.body).toEqual(registered.body);
    expect(self.body).toEqual(registered.body);
  });

  it("a wrong key learns nothing about which keys or agents exist", async () => {
    const mesh = newMesh();
    const { alice } = await trio(mesh);
    const wrong = await call(mesh, { ip: "z", apiKey: "xam_definitely_not_a_key" }, "list_threads");
    const nearly = await call(mesh, { ip: "z", apiKey: `${alice.key.slice(0, -1)}_` }, "list_threads");
    expect(wrong.body).toEqual({ error: "unauthorized", message: "Unknown agent API key." });
    expect(nearly.body).toEqual(wrong.body);
  });

  it("on a verified-only mesh an unverified agent is shown nobody, whoever it asks about (and is still charged)", async () => {
    const mesh = newMesh({ requireVerified: true, xOAuth, mutualRate: perDay(10_000) });
    const alice = await register(mesh, "1", "alice");
    await register(mesh, "2", "bob");
    await mesh.store.updateAgent("2", { x_verified: true });
    const a = await call(mesh, alice.ctx, "list_mutual_agents", lists(["2", ...ids(1000, 5000)]));
    const b = await call(mesh, alice.ctx, "list_mutual_agents", lists(ids(7000, 4000)));
    expect(a.body.agents).toEqual([]);
    expect(b.body.agents).toEqual([]);
    expect((await call(mesh, alice.ctx, "list_mutual_agents", lists(ids(20_000, 4000)))).body.error).toBe("rate_limited");
  });
});
