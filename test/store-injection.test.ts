// Hostile strings as data: every store method binds its arguments, so SQL, LIKE wildcards and JSON
// syntax in an id, handle, hash or message are stored and compared as plain text. The tool schemas
// would refuse most of these long before the store; this checks the store does not depend on that.
import { describe, expect, it } from "vitest";
import { MemoryStore, SqliteStore, type NewAgent, type Store } from "../src/store.js";

const HOSTILE = [
  "1' OR '1'='1",
  `1" OR "1"="1`,
  "1; DROP TABLE mesh_agents; --",
  "1) OR 1=1 --",
  "%",
  "_",
  "a%b_c",
  "\\",
  "'",
  `"]}, {"x":"`,
  `["1","2"]`,
  "$[0]",
  "?",
  "?1",
  ":id",
  "@id",
  "NULL",
  "\u0000",
  "1\u0000' OR 1=1",
  "x' UNION SELECT api_key_hash,2,3,4,5,6,7,8,9,10,11 FROM mesh_agents --",
];

const agent = (id: string, handle: string, hash: string): NewAgent => ({ x_user_id: id, x_handle: handle, agent_card_url: null, display_name: null, owner_opt_in: true, opted_in_at: null, api_key_hash: hash });

const STORES: [string, () => Store][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["SqliteStore", () => new SqliteStore(":memory:")],
];

describe.each(STORES)("hostile strings are plain data: %s", (_name, make) => {
  it("lookups by id, handle and key hash match exactly or not at all", async () => {
    const store = make();
    await store.insertAgent(agent("1", "alice", "hash-alice"));
    await store.insertAgent(agent("2", "a_ice", "hash-2"));
    await store.insertAgent(agent("3", "bob", "hash-bob"));
    for (const s of HOSTILE) {
      expect(await store.getAgentByXUserId(s), s).toBeNull();
      expect(await store.getAgentByHandle(s), s).toBeNull();
      expect(await store.getAgentByKeyHash(s), s).toBeNull();
      expect(await store.getOptedInAgents([s]), s).toEqual([]);
      expect((await store.getOptedInAgents([s, "3"])).map((a) => a.x_user_id), s).toEqual(["3"]);
      expect(await store.getThread(s), s).toBeNull();
      expect(await store.listThreadsFor(s), s).toEqual([]);
      expect(await store.listMessages(s, 50), s).toEqual([]);
    }
    // "_" and "%" are not wildcards: "a_ice" is found only by its own name.
    expect((await store.getAgentByHandle("a_ice"))?.x_user_id).toBe("2");
    expect((await store.getAgentByHandle("A_ICE"))?.x_user_id).toBe("2");
    expect(await store.getAgentByHandle("a%")).toBeNull();
    expect(await store.getAgentByHandle("_lice")).toBeNull();
    expect((await store.getAgentByHandle("alice"))?.x_user_id).toBe("1");
    // All three rows are still there.
    expect((await store.getOptedInAgents(["1", "2", "3"])).map((a) => a.x_user_id).sort()).toEqual(["1", "2", "3"]);
  });

  it("stores and returns hostile values unchanged, and they select only themselves", async () => {
    const store = make();
    await store.insertAgent(agent("1", "alice", "hash-alice"));
    for (const [i, s] of HOSTILE.entries()) {
      if (s.includes("\u0000")) continue; // SQLite text stops at NUL; the schemas never let one in
      const id = `h${i}`;
      const row = await store.insertAgent({ ...agent(id, `handle${i}`, `hash-${i}`), display_name: s, agent_card_url: s });
      expect(row).toMatchObject({ display_name: s, agent_card_url: s });
      const patched = await store.updateAgent(id, { x_handle: s, api_key_hash: s });
      expect(patched).toMatchObject({ x_user_id: id, x_handle: s, api_key_hash: s });
      expect((await store.getAgentByKeyHash(s))?.x_user_id).toBe(id);
      expect((await store.getAgentByHandle(s))?.x_user_id).toBe(id);

      const thread = await store.insertThread({ goal: s, proposer_x_user_id: "1", participants: ["1", s], accepted_by: ["1"], status: "proposed" });
      expect((await store.getThread(thread.id))!).toMatchObject({ goal: s, participants: ["1", s] });
      expect((await store.listThreadsFor(s)).map((t) => t.id)).toEqual([thread.id]);
      const message = await store.insertMessage({ thread_id: thread.id, from_x_user_id: s, kind: "update", needs_human: false, message: { parts: [{ kind: "text", text: s }, { kind: "data", data: { [s]: s } }] } });
      const [back] = await store.listMessages(thread.id, 10);
      expect(back).toMatchObject({ id: message.id, from_x_user_id: s, message: { parts: [{ kind: "text", text: s }, { kind: "data", data: { [s]: s } }] } });
      // A compare-and-set with a hostile stamp matches nothing.
      expect(await store.updateThread(thread.id, { status: "canceled" }, s)).toBeNull();
      expect((await store.getThread(thread.id))!.status).toBe("proposed");
    }
    // Alice's row was never touched by any of it.
    expect(await store.getAgentByXUserId("1")).toMatchObject({ x_handle: "alice", api_key_hash: "hash-alice", x_verified: false });
    expect((await store.listThreadsFor("1")).length).toBe(Math.min(100, HOSTILE.filter((s) => !s.includes("\u0000")).length));
  });
});

describe("SqliteStore", () => {
  it("answers a database error with a fixed message, logging the detail instead", async () => {
    const store = new SqliteStore(":memory:");
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    try {
      await store.insertAgent(agent("1", "alice", "hash-secretish"));
      await expect(store.insertAgent(agent("1", "alice2", "hash-other"))).rejects.toThrow("The mesh database is unavailable or rejected the request.");
      await expect(store.insertThread({ goal: "", proposer_x_user_id: "1", participants: ["1"], accepted_by: [], status: "proposed" })).rejects.toThrow(/^The mesh database is unavailable/);
      await expect(store.insertThread({ goal: "g", proposer_x_user_id: "nobody", participants: ["1"], accepted_by: [], status: "proposed" })).rejects.toThrow(/^The mesh database is unavailable/);
    } finally {
      console.error = original;
    }
    expect(logged).toHaveLength(3);
    for (const line of logged) {
      expect(line).toMatch(/^\[x-agent-mesh\] sqlite error: /);
      expect(line).not.toContain("hash-"); // constraint names, never row values
    }
  });

  it("clamps a message limit to a whole, non-negative number", async () => {
    const store = new SqliteStore(":memory:");
    await store.insertAgent(agent("1", "alice", "h"));
    const thread = await store.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1"], accepted_by: ["1"], status: "proposed" });
    for (let i = 0; i < 5; i++) await store.insertMessage({ thread_id: thread.id, from_x_user_id: "1", kind: "update", needs_human: false, message: { n: i } });
    expect(await store.listMessages(thread.id, -1)).toEqual([]);
    expect(await store.listMessages(thread.id, 0)).toEqual([]);
    expect((await store.listMessages(thread.id, 2.9)).map((m) => m.message.n)).toEqual([3, 4]);
    expect(await store.listMessages(thread.id, 1000)).toHaveLength(5);
  });
});
