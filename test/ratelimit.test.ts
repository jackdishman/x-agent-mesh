import { describe, expect, it } from "vitest";
import { loadConfig, LIMITS } from "../src/config.js";
import { DEFAULT_MAX_KEYS, RateLimiter } from "../src/ratelimit.js";
import { activeThread, call, newMesh, register, trio } from "./helpers.js";

describe("RateLimiter", () => {
  it("allows the burst, then answers the seconds to wait, then refills", () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 0.5 }, () => t);
    expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([0, 0, 0]);
    expect(rl.take("a")).toBe(2); // one token at 0.5/s
    expect(rl.take("b")).toBe(0); // keys are independent
    t += 2000;
    expect(rl.take("a")).toBe(0);
    expect(rl.take("a")).toBeGreaterThan(0);
    t += 3_600_000; // never refills past the capacity
    expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([0, 0, 0]);
    expect(rl.take("a")).toBeGreaterThan(0);
  });

  it("charges a cost, and never refuses an oversized cost forever", () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 100, refillPerSec: 10 }, () => t);
    expect(rl.take("a", 60)).toBe(0);
    expect(rl.take("a", 60)).toBe(2); // 40 left, 20 short at 10/s
    expect(rl.take("a", 40)).toBe(0);
    // A cost above the capacity is charged as a full bucket rather than being impossible.
    expect(rl.take("a", 1000)).toBe(10);
    t += 10_000;
    expect(rl.take("a", 1000)).toBe(0);
    expect(rl.take("a", 1)).toBeGreaterThan(0);
    // A negative cost cannot mint tokens.
    expect(rl.take("b", -500)).toBe(0);
    expect(rl.take("b", 100)).toBe(0);
    expect(rl.take("b", 1)).toBeGreaterThan(0);
  });

  it("peek answers what take would, without taking or remembering anything", () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 100, refillPerSec: 10 }, () => t);
    expect(rl.peek("a", 60)).toBe(0);
    expect(rl.peek("a", 60)).toBe(0); // still all there
    expect(rl.size).toBe(0); // an unseen key is not remembered
    expect(rl.take("a", 60)).toBe(0);
    expect(rl.peek("a", 60)).toBe(2);
    expect(rl.peek("a", 40)).toBe(0);
    expect(rl.peek("a", 1000)).toBe(6); // an oversized cost is a full bucket, as in take
    t += 2000;
    expect(rl.peek("a", 60)).toBe(0); // refill is taken into account...
    t -= 2000;
    expect(rl.take("a", 60)).toBe(2); // ...but was not written back
    expect(rl.peek("x".repeat(500))).toBe(0);
    expect(rl.size).toBe(1);
  });

  it("does not lose tokens when the clock steps backwards", () => {
    let t = 10_000;
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 }, () => t);
    expect(rl.take("a")).toBe(0);
    t -= 60_000;
    expect(rl.take("a")).toBe(0);
    expect(rl.take("a")).toBeGreaterThan(0);
  });

  it("never remembers more than maxKeys keys, even when every bucket is in use", () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.000001 }, () => t, 100);
    for (let i = 0; i < 5000; i++) {
      rl.take(`k${i}`);
      expect(rl.size).toBeLessThanOrEqual(100);
    }
    // Refilled buckets are dropped first: after a long quiet spell one new key clears the rest.
    t += 1e13;
    rl.take("fresh");
    expect(rl.size).toBe(1);
  });

  it("keeps the default cap small enough for a 256 MB machine, and cuts oversized keys", () => {
    expect(DEFAULT_MAX_KEYS).toBeLessThanOrEqual(10_000);
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.001 });
    const long = "x".repeat(10_000);
    expect(rl.take(long)).toBe(0);
    expect(rl.take(`${"x".repeat(128)}different-tail`)).toBeGreaterThan(0); // same bucket after the cut
    expect(JSON.stringify([...(rl as any).buckets.keys()]).length).toBeLessThan(200);
  });
});

describe("loadConfig: limits", () => {
  it("has per-IP HTTP and per-agent write budgets with safe defaults, all overridable", () => {
    const d = loadConfig({});
    expect(d.httpRate).toEqual({ capacity: 240, refillPerSec: 20 });
    expect(d.writeRate.capacity).toBe(5120 * 1024);
    expect(d.writeRate.refillPerSec).toBeCloseTo((5120 * 1024) / 86_400);
    const o = loadConfig({ MESH_HTTP_BURST: "10", MESH_HTTP_PER_MIN: "60", MESH_WRITE_KB_PER_DAY: "1024" });
    expect(o.httpRate).toEqual({ capacity: 10, refillPerSec: 1 });
    expect(o.writeRate.capacity).toBe(1024 * 1024);
    // One maximal message must always fit, however small the budget is set.
    expect(loadConfig({ MESH_WRITE_KB_PER_DAY: "1" }).writeRate.capacity).toBe(LIMITS.minWriteBurstBytes);
    expect(LIMITS.minWriteBurstBytes).toBeGreaterThan(LIMITS.text * 4 + LIMITS.dataBytes);
    for (const bad of ["0", "-5", "abc", "Infinity"]) {
      expect(() => loadConfig({ MESH_HTTP_BURST: bad }), bad).toThrow(/MESH_HTTP_BURST/);
      expect(() => loadConfig({ MESH_WRITE_KB_PER_DAY: bad }), bad).toThrow(/MESH_WRITE_KB_PER_DAY/);
    }
  });

  it("refuses a public URL or redirect URI that is not a plain http(s) URL", () => {
    expect(loadConfig({ MESH_PUBLIC_URL: " https://m.example/// " }).publicUrl).toBe("https://m.example");
    expect(loadConfig({ MESH_PUBLIC_URL: "https://m.example/base/" }).xOAuth.redirectUri).toBe("https://m.example/base/auth/x/callback");
    for (const bad of ["m.example", "javascript:alert(1)", "ftp://m.example", "https://user:pw@m.example", "https://m.example/?x=1", "https://m.example/#frag", "//m.example"]) {
      expect(() => loadConfig({ MESH_PUBLIC_URL: bad }), bad).toThrow(/MESH_PUBLIC_URL/);
      expect(() => loadConfig({ X_REDIRECT_URI: bad }), bad).toThrow(/X_REDIRECT_URI/);
    }
    // The error never repeats the value (a URL with credentials in it would be a secret).
    try {
      loadConfig({ MESH_PUBLIC_URL: "https://user:hunter2@m.example" });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain("hunter2");
    }
  });
});

describe("per-agent write budget", () => {
  const budget = (capacity: number) => ({ writeRate: { capacity, refillPerSec: 1 } });

  it("limits how many bytes one agent can store, with a retry-after, and refills", async () => {
    let t = 1_800_000_000_000;
    const mesh = newMesh(budget(10_000), () => t);
    const { alice, bob, threadId } = await activeThread(mesh);
    const big = "x".repeat(3000);
    const post = (who: typeof alice, text = big) => call(mesh, who.ctx, "post_update", { thread_id: threadId, text });
    expect((await post(alice)).isError).toBe(false);
    expect((await post(alice)).isError).toBe(false);
    const third = await post(alice);
    expect(third.body.error).toBe("rate_limited");
    expect(third.body.retry_after_seconds).toBeGreaterThan(0);
    expect(third.body.message).toContain("do not retry in a loop");
    // Nothing was stored for the refused write, and the thread did not change.
    const read = await call(mesh, alice.ctx, "read_thread", { thread_id: threadId });
    expect(read.body.messages.filter((m: any) => m.kind === "update")).toHaveLength(2);
    // Budgets are per agent: bob is unaffected. Reads are free.
    expect((await post(bob)).isError).toBe(false);
    expect((await call(mesh, alice.ctx, "list_threads")).isError).toBe(false);
    t += third.body.retry_after_seconds * 1000;
    expect((await post(alice)).isError).toBe(false);
  });

  it("counts data parts, goals, payment drafts and repeated accepts; cancel is never blocked", async () => {
    const mesh = newMesh(budget(6000));
    const { alice, bob, carol } = await trio(mesh);
    await call(mesh, alice.ctx, "list_mutual_agents", { follower_ids: ["2", "3"], following_ids: ["2", "3"] });
    // A 2000-character goal is stored twice (thread + first message): 4000 + overhead.
    const p = await call(mesh, alice.ctx, "propose_goal", { goal: "g".repeat(2000), participant_x_user_ids: ["2", "3"] });
    expect(p.isError).toBe(false);
    const again = await call(mesh, alice.ctx, "propose_goal", { goal: "g".repeat(2000), participant_x_user_ids: ["2"] });
    expect(again.body.error).toBe("rate_limited");
    expect((await call(mesh, alice.ctx, "list_threads")).body.threads).toHaveLength(1); // no thread was created

    // Accepting a still-proposed thread over and over stores a message each time: it is charged too.
    const threadId = p.body.thread.thread_id;
    let refused = 0;
    for (let i = 0; i < 20; i++) if ((await call(mesh, bob.ctx, "accept_goal", { thread_id: threadId, accept: true })).body.error === "rate_limited") refused++;
    expect(refused).toBeGreaterThan(0);
    expect((await call(mesh, carol.ctx, "accept_goal", { thread_id: threadId, accept: true })).body.thread.status).toBe("active");

    const data = await call(mesh, carol.ctx, "post_update", { thread_id: threadId, text: "d", data: { blob: "y".repeat(5000) } });
    expect(data.body.error).toBe("rate_limited");
    expect((await call(mesh, carol.ctx, "post_update", { thread_id: threadId, text: "t".repeat(4000) })).isError).toBe(false);
    const memo = () => call(mesh, carol.ctx, "propose_payment", { thread_id: threadId, to_x_handle: "alice", amount: 1, memo: "m".repeat(280) });
    expect((await memo()).isError).toBe(false);
    expect((await memo()).body.error).toBe("rate_limited");

    // An agent that is out of budget can still cancel.
    expect((await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "x".repeat(4000) })).body.error).toBe("rate_limited");
    const { handleA2A } = await import("../src/a2a.js");
    const out = await handleA2A(mesh, alice.ctx, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/cancel", params: { id: threadId } }));
    expect((out.body as any).result.status.state).toBe("canceled");
  });

  it("answers 429 with Retry-After over A2A", async () => {
    const mesh = newMesh(budget(4000));
    const { alice, threadId } = await activeThread(mesh);
    const { handleA2A } = await import("../src/a2a.js");
    const send = () => handleA2A(mesh, alice.ctx, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "agent", messageId: "m", taskId: threadId, parts: [{ kind: "text", text: "z".repeat(2000) }] } } }));
    expect((await send()).status).toBe(200);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers?.["Retry-After"])).toBeGreaterThan(0);
    expect((limited.body as any).error.code).toBe(-32029);
  });
});

describe("mutual-set cache", () => {
  const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(from + i));

  it("holds at most LIMITS.mutualIdsTotal ids in all, dropping the least recently supplied sets", async () => {
    const mesh = newMesh();
    const perAgent = 10_000;
    const agents = [];
    const count = LIMITS.mutualIdsTotal / perAgent + 3;
    for (let i = 0; i < count; i++) agents.push(await register(mesh, String(1_000_000 + i), `agent_${i}`));
    for (const a of agents) {
      const list = ids(5_000_000, perAgent);
      const r = await call(mesh, a.ctx, "list_mutual_agents", { follower_ids: list, following_ids: list });
      expect(r.body.mutual_count).toBe(perAgent);
      expect((mesh as any).mutualIds).toBeLessThanOrEqual(LIMITS.mutualIdsTotal);
    }
    const cache = (mesh as any).mutuals as Map<string, { ids: Set<string> }>;
    expect(cache.size).toBe(LIMITS.mutualIdsTotal / perAgent);
    expect([...cache.values()].reduce((n, v) => n + v.ids.size, 0)).toBe((mesh as any).mutualIds);
    // The first three were dropped, the rest kept.
    expect(cache.has(agents[0]!.id)).toBe(false);
    expect(cache.has(agents[2]!.id)).toBe(false);
    expect(cache.has(agents[3]!.id)).toBe(true);
    expect(cache.has(agents[agents.length - 1]!.id)).toBe(true);
    // A dropped agent is told to supply its lists again: nothing is assumed about its mutuals.
    const p = await call(mesh, agents[0]!.ctx, "propose_goal", { goal: "g", participant_x_user_ids: [agents[5]!.id] });
    expect(p.body.error).toBe("forbidden");
    expect(p.body.message).toContain("list_mutual_agents");
  });

  it("keeps the count right when an agent replaces its own set, and when a set expires", async () => {
    let t = 1_800_000_000_000;
    const mesh = newMesh({ mutualTtlMs: 1000 }, () => t);
    const a = await register(mesh, "1", "alice");
    const b = await register(mesh, "2", "bob");
    await call(mesh, a.ctx, "list_mutual_agents", { follower_ids: ids(10, 500), following_ids: ids(10, 500) });
    expect((mesh as any).mutualIds).toBe(500);
    await call(mesh, a.ctx, "list_mutual_agents", { follower_ids: ids(10, 20), following_ids: ids(10, 20) });
    expect((mesh as any).mutualIds).toBe(20);
    await call(mesh, b.ctx, "list_mutual_agents", { follower_ids: ["1"], following_ids: ["1"] });
    expect((mesh as any).mutualIds).toBe(21);
    t += 5000;
    expect((await call(mesh, a.ctx, "propose_goal", { goal: "g", participant_x_user_ids: ["2"] })).body.error).toBe("forbidden");
    expect((mesh as any).mutualIds).toBe(1);
  });
});
