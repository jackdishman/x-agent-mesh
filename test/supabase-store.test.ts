import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createStore, MemoryStore, SupabaseStore } from "../src/store.js";

/** A stand-in for supabase-js's query builder: records every call, resolves to the next queued result. */
function mockClient(results: { data: unknown; error: { message: string } | null }[]) {
  const queries: { table: string; calls: [string, ...unknown[]][] }[] = [];
  const client = {
    from(table: string) {
      const q = { table, calls: [] as [string, ...unknown[]][] };
      queries.push(q);
      const builder: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") {
            const r = results.shift() ?? { data: null, error: null };
            return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(r).then(ok, bad);
          }
          return (...args: unknown[]) => {
            q.calls.push([prop, ...args]);
            return builder;
          };
        },
      });
      return builder;
    },
  };
  return { db: client as unknown as SupabaseClient, queries };
}
const ok = (data: unknown) => ({ data, error: null });

describe("SupabaseStore (mocked client)", () => {
  it("looks agents up by key hash and by handle (escaping LIKE wildcards)", async () => {
    const { db, queries } = mockClient([ok({ id: "a", x_user_id: "1" }), ok([{ x_handle: "jackXd" }, { x_handle: "Jack_D" }])]);
    const store = new SupabaseStore(db);
    expect(await store.getAgentByKeyHash("abc")).toMatchObject({ x_user_id: "1" });
    expect(queries[0]).toEqual({ table: "mesh_agents", calls: [["select", "*"], ["eq", "api_key_hash", "abc"], ["maybeSingle"]] });
    const found = await store.getAgentByHandle("jack_d");
    expect(queries[1]!.calls[1]).toEqual(["ilike", "x_handle", "jack\\_d"]);
    expect(found?.x_handle).toBe("Jack_D"); // the wildcard match "jackXd" is not returned
  });

  it("asks only for opted-in agents, in chunks", async () => {
    const { db, queries } = mockClient([ok([{ x_user_id: "0" }]), ok([{ x_user_id: "200" }]), ok(null)]);
    const store = new SupabaseStore(db);
    const ids = Array.from({ length: 450 }, (_, i) => String(i));
    const agents = await store.getOptedInAgents([...ids, "0"]);
    expect(agents.map((a) => a.x_user_id)).toEqual(["0", "200"]);
    expect(queries).toHaveLength(3);
    expect((queries[0]!.calls[1]![2] as string[]).length).toBe(200);
    expect((queries[2]!.calls[1]![2] as string[]).length).toBe(50);
    for (const q of queries) expect(q.calls[2]).toEqual(["eq", "owner_opt_in", true]);
  });

  it("updates threads with compare-and-set on updated_at", async () => {
    const { db, queries } = mockClient([ok({ id: "t", status: "active" }), ok(null)]);
    const store = new SupabaseStore(db);
    expect(await store.updateThread("t", { status: "active" }, "2026-11-16T00:00:00+00:00")).toMatchObject({ status: "active" });
    const calls = queries[0]!.calls;
    expect(queries[0]!.table).toBe("mesh_threads");
    expect(calls[0]![0]).toBe("update");
    expect(calls[0]![1]).toMatchObject({ status: "active", updated_at: expect.any(String) });
    expect(calls.slice(1, 3)).toEqual([["eq", "id", "t"], ["eq", "updated_at", "2026-11-16T00:00:00+00:00"]]);
    expect(await store.updateThread("t", { status: "active" }, "stale")).toBeNull(); // lost the race
  });

  it("lists a participant's threads and a thread's latest messages oldest-first", async () => {
    const { db, queries } = mockClient([ok([]), ok([{ id: "m2" }, { id: "m1" }])]);
    const store = new SupabaseStore(db);
    await store.listThreadsFor("1", "active");
    expect(queries[0]!.calls).toEqual([["select", "*"], ["contains", "participants", ["1"]], ["eq", "status", "active"], ["order", "updated_at", { ascending: false }], ["limit", 100]]);
    const msgs = await store.listMessages("t", 2);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(queries[1]!.calls).toContainEqual(["limit", 2]);
  });

  it("inserts rows and hides database error text from callers", async () => {
    const { db, queries } = mockClient([ok({ id: "m" }), { data: null, error: { message: "relation secret_table does not exist" } }]);
    const store = new SupabaseStore(db);
    const m = { thread_id: "t", from_x_user_id: "1", kind: "update" as const, message: { kind: "message" }, needs_human: false };
    expect(await store.insertMessage(m)).toEqual({ id: "m" });
    expect(queries[0]).toEqual({ table: "mesh_messages", calls: [["insert", m], ["select", "*"], ["single"]] });
    await expect(store.getThread("t")).rejects.toThrow(/^The mesh database is unavailable/);
  });
});

describe("createStore", () => {
  it("defaults to MemoryStore without Supabase env, SupabaseStore with it", () => {
    expect(createStore({})).toBeInstanceOf(MemoryStore);
    expect(createStore({ SUPABASE_URL: "https://example.supabase.co" })).toBeInstanceOf(MemoryStore);
    expect(createStore({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBeInstanceOf(SupabaseStore);
  });
});
