// The per-agent storage quota: stored bytes are counted by the store with every write (and so
// survive restarts), the limit is enforced on every write path before anything changes, and an
// existing database gains the counters at start-up without any row being altered.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleA2A } from "../src/a2a.js";
import { LIMITS, loadConfig, testConfig } from "../src/config.js";
import { Mesh } from "../src/mesh.js";
import { MemoryStore, MESSAGE_OVERHEAD_BYTES, messageBytes, SqliteStore, StoreError, SupabaseStore, THREAD_OVERHEAD_BYTES, threadBytes, type NewAgent, type Store } from "../src/store.js";
import { call, register, type TestAgent } from "./helpers.js";
import { dumpFile, LegacyDb } from "./legacy-schema.js";

const tmp = mkdtempSync(join(tmpdir(), "x-agent-mesh-quota-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let files = 0;
const tmpFile = () => join(tmp, `mesh-${++files}.db`);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());
const logged = (): string[] => errors.mock.calls.map((c: unknown[]) => c.map(String).join(" "));

const newAgent = (id: string, handle: string): NewAgent => ({ x_user_id: id, x_handle: handle, agent_card_url: null, display_name: null, owner_opt_in: true, opted_in_at: null, api_key_hash: `hash-${id}` });
const rawDump = (file: string) => dumpFile(file) as { agents: any[]; threads: any[]; messages: any[] };
const used = async (s: Store, id: string) => (await s.getAgentByXUserId(id))!.stored_bytes;
const msg = (text: string) => ({ kind: "message", role: "agent", parts: [{ kind: "text", text }] });

const STORES: [string, () => Store][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["SqliteStore (:memory:)", () => new SqliteStore(":memory:")],
  ["SqliteStore (file)", () => new SqliteStore(tmpFile())],
];

describe("the size formula", () => {
  it("counts UTF-8 bytes of what is stored, plus a fixed overhead per row", () => {
    expect(THREAD_OVERHEAD_BYTES).toBe(256);
    expect(MESSAGE_OVERHEAD_BYTES).toBe(128);
    expect(threadBytes({ goal: "abc", participants: ["1", "22"] })).toBe(3 + '["1","22"]'.length + 256);
    expect(threadBytes({ goal: "héllo 👋", participants: [] })).toBe(Buffer.byteLength("héllo 👋") + 2 + 256);
    expect(messageBytes({ a: "é" })).toBe(Buffer.byteLength('{"a":"é"}') + 128);
  });
});

describe.each(STORES)("stored_bytes: %s", (_name, make) => {
  it("starts at 0 and grows by exactly the size of each thread (proposer) and message (sender)", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    await s.insertAgent(newAgent("2", "bob"));
    expect(await used(s, "1")).toBe(0);
    const t = { goal: "Plan the meetup — 計画 👋", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" as const };
    const thread = await s.insertThread(t);
    expect(await used(s, "1")).toBe(threadBytes(t));
    expect(await used(s, "2")).toBe(0); // being named in a thread costs nothing
    const m1 = msg("hello, wörld");
    await s.insertMessage({ thread_id: thread.id, from_x_user_id: "2", kind: "update", message: m1, needs_human: false });
    expect(await used(s, "2")).toBe(messageBytes(m1));
    const m2 = { ...msg("x".repeat(4000)), parts: [{ kind: "text", text: "x".repeat(4000) }, { kind: "data", data: { nested: ["é", 1, null, { deep: true }] } }] };
    await s.insertMessage({ thread_id: thread.id, from_x_user_id: "1", kind: "update", message: m2, needs_human: true });
    expect(await used(s, "1")).toBe(threadBytes(t) + messageBytes(m2));
    // Status changes and agent updates do not move the counter.
    await s.updateThread(thread.id, { status: "active", accepted_by: ["1", "2"] }, thread.updated_at);
    const patched = await s.updateAgent("1", { api_key_hash: "rotated", display_name: "A", x_verified: true });
    expect(patched.stored_bytes).toBe(threadBytes(t) + messageBytes(m2));
    expect((await s.getAgentByKeyHash("rotated"))!.stored_bytes).toBe(patched.stored_bytes);
    expect((await s.getAgentByHandle("ALICE"))!.stored_bytes).toBe(patched.stored_bytes);
    expect((await s.getOptedInAgents(["1"]))[0]!.stored_bytes).toBe(patched.stored_bytes);
  });

  it("a write with a limit is refused when it would pass it, storing nothing; at the limit exactly it is let in", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    const t = { goal: "g".repeat(100), proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" as const };
    const size = threadBytes(t);
    const refused = await s.insertThread(t, { limitBytes: size - 1 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StoreError);
    expect((refused as StoreError).code).toBe("quota_exceeded");
    expect((refused as StoreError).usage).toEqual({ usedBytes: 0, neededBytes: size, limitBytes: size - 1 });
    expect(await s.listThreadsFor("1")).toEqual([]);
    expect(await s.listThreadsFor("2")).toEqual([]);
    expect(await used(s, "1")).toBe(0);

    const thread = await s.insertThread(t, { limitBytes: size });
    expect(await used(s, "1")).toBe(size);
    const m = msg("hello");
    const over = await s.insertMessage({ thread_id: thread.id, from_x_user_id: "1", kind: "update", message: m, needs_human: false }, { limitBytes: size + messageBytes(m) - 1 }).catch((e: unknown) => e);
    expect((over as StoreError).code).toBe("quota_exceeded");
    expect((over as StoreError).usage).toEqual({ usedBytes: size, neededBytes: messageBytes(m), limitBytes: size + messageBytes(m) - 1 });
    expect(await s.listMessages(thread.id, 10)).toEqual([]);
    expect(await used(s, "1")).toBe(size);
    await s.insertMessage({ thread_id: thread.id, from_x_user_id: "1", kind: "update", message: m, needs_human: false }, { limitBytes: size + messageBytes(m) });
    expect(await used(s, "1")).toBe(size + messageBytes(m));
    // Without a limit nothing is refused, however much is already there.
    await s.insertMessage({ thread_id: thread.id, from_x_user_id: "1", kind: "update", message: m, needs_human: false });
    expect(await used(s, "1")).toBe(size + 2 * messageBytes(m));
    expect(logged()).toEqual([]); // a quota refusal is not a database error
  });

  it("concurrent writes cannot pass the limit together", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    const thread = await s.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1"], accepted_by: ["1"], status: "proposed" });
    const base = await used(s, "1");
    const m = msg("y".repeat(500));
    const size = messageBytes(m);
    const limit = base + 7 * size + 10; // room for seven, not eight
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => s.insertMessage({ thread_id: thread.id, from_x_user_id: "1", kind: "update", message: m, needs_human: false }, { limitBytes: limit })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(7);
    for (const r of results) if (r.status === "rejected") expect((r.reason as StoreError).code).toBe("quota_exceeded");
    expect(await used(s, "1")).toBe(base + 7 * size);
    expect(await s.listMessages(thread.id, 100)).toHaveLength(7);
  });

  it("a message from an id that has no agent row is stored and counted against nobody", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    const thread = await s.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    const before = await used(s, "1");
    await s.insertMessage({ thread_id: thread.id, from_x_user_id: "2", kind: "update", message: msg("hi"), needs_human: false }, { limitBytes: 10_000 });
    expect(await used(s, "1")).toBe(before);
    expect(await s.listMessages(thread.id, 10)).toHaveLength(1);
  });
});

describe("MemoryStore and SqliteStore count the same", () => {
  it("for the same writes, including text SQLite must encode", async () => {
    const texts = ["plain", "héllo wörld", "日本語のテキスト", "👋🏽 emoji", "quote \" and \\ backslash", "line\nbreak\ttab", "‮ bidi ​ zero-width", "a".repeat(4000), "lone \ud83d surrogate"];
    const stores = [new MemoryStore(), new SqliteStore(":memory:")];
    const totals: number[] = [];
    for (const s of stores) {
      await s.insertAgent(newAgent("1", "alice"));
      for (const text of texts) {
        const t = await s.insertThread({ goal: text.slice(0, 2000), proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
        await s.insertMessage({ thread_id: t.id, from_x_user_id: "1", kind: "update", message: { ...msg(text), data: { text, n: 1.5, list: [text] } }, needs_human: false });
      }
      totals.push(await used(s, "1"));
    }
    expect(totals[0]).toBe(totals[1]);
    expect(totals[0]).toBeGreaterThan(8000);
  });
});

describe("SqliteStore: the counters are persistent and match the tables", () => {
  const rawOf = (s: SqliteStore) => (s as unknown as { db: DatabaseSync }).db;

  it("survive a restart, and a fresh recount at start-up finds nothing to correct", async () => {
    const file = tmpFile();
    const a = new SqliteStore(file);
    await a.insertAgent(newAgent("1", "alice"));
    await a.insertAgent(newAgent("2", "bob"));
    const texts = ["plain", "héllo 👋", "x".repeat(4000), "nul \u0000 inside", "lone \ud83d surrogate", "‮"];
    for (const text of texts) {
      const t = await a.insertThread({ goal: text.slice(0, 2000), proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
      await a.insertMessage({ thread_id: t.id, from_x_user_id: "2", kind: "update", message: msg(text), needs_human: false });
      await a.insertMessage({ thread_id: t.id, from_x_user_id: "1", kind: "update", message: { ...msg(text), extra: { text } }, needs_human: false });
    }
    const before = { alice: await used(a, "1"), bob: await used(a, "2") };
    expect(before.alice).toBeGreaterThan(before.bob);
    expect(before.bob).toBeGreaterThan(4000);
    a.close();

    const b = new SqliteStore(file);
    // What was counted write by write is exactly what the tables hold: nothing to correct.
    // Nothing had to be read: every row was counted when it was written.
    expect(b.usageAtStart).toEqual({ mode: "none", agents: 2, corrected: 0, totalBytes: before.alice + before.bob, largestBytes: before.alice });
    // And a full recount from the tables agrees with the running counters, byte for byte.
    expect(b.recomputeUsage()).toEqual({ mode: "full", agents: 2, corrected: 0, totalBytes: before.alice + before.bob, largestBytes: before.alice });
    expect({ alice: await used(b, "1"), bob: await used(b, "2") }).toEqual(before);
    expect(logged()).toEqual([]);
    // A limit given after the restart is measured against what was stored before it.
    const t = (await b.listThreadsFor("2"))[0]!;
    const m = msg("after restart");
    const refused = await b.insertMessage({ thread_id: t.id, from_x_user_id: "2", kind: "update", message: m, needs_human: false }, { limitBytes: before.bob + messageBytes(m) - 1 }).catch((e: unknown) => e);
    expect((refused as StoreError).code).toBe("quota_exceeded");
    b.close();
  });

  it("two connections to one file add to the same counter", async () => {
    const file = tmpFile();
    const a = new SqliteStore(file);
    const b = new SqliteStore(file);
    await a.insertAgent(newAgent("1", "alice"));
    const t = await a.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1"], accepted_by: ["1"], status: "proposed" });
    const m = msg("z".repeat(200));
    await b.insertMessage({ thread_id: t.id, from_x_user_id: "1", kind: "update", message: m, needs_human: false });
    await a.insertMessage({ thread_id: t.id, from_x_user_id: "1", kind: "update", message: m, needs_human: false });
    const total = threadBytes({ goal: "g", participants: ["1"] }) + 2 * messageBytes(m);
    expect(await used(a, "1")).toBe(total);
    expect(await used(b, "1")).toBe(total);
    const refused = await b.insertMessage({ thread_id: t.id, from_x_user_id: "1", kind: "update", message: m, needs_human: false }, { limitBytes: total + 10 }).catch((e: unknown) => e);
    expect((refused as StoreError).code).toBe("quota_exceeded");
    a.close();
    b.close();
  });

  /** Two agents, a thread by alice, a message by bob; returns the right numbers. */
  async function small(file: string) {
    const a = new SqliteStore(file);
    await a.insertAgent(newAgent("1", "alice"));
    await a.insertAgent(newAgent("2", "bob"));
    const t = await a.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    await a.insertMessage({ thread_id: t.id, from_x_user_id: "2", kind: "update", message: msg("hi"), needs_human: false });
    return { store: a, threadId: t.id, right: { alice: await used(a, "1"), bob: await used(a, "2") } };
  }
  const marks = (s: SqliteStore) => rawOf(s).prepare("select key, value from mesh_meta order by key").all().map((r) => `${String(r.key)}=${String(r.value)}`);

  it("keeps two marks (the last counted rowid of each table), so a normal start reads no rows", async () => {
    const file = tmpFile();
    const { store, threadId } = await small(file);
    expect(marks(store)).toEqual(["usage_counted_messages_rowid=1", "usage_counted_threads_rowid=1"]);
    await store.insertMessage({ thread_id: threadId, from_x_user_id: "1", kind: "update", message: msg("two"), needs_human: false });
    // A refused or failed insert moves nothing.
    await expect(store.insertMessage({ thread_id: threadId, from_x_user_id: "1", kind: "update", message: msg("three"), needs_human: false }, { limitBytes: 1 })).rejects.toThrow();
    await expect(store.insertMessage({ thread_id: "missing", from_x_user_id: "1", kind: "update", message: msg("x"), needs_human: false })).rejects.toThrow();
    expect(marks(store)).toEqual(["usage_counted_messages_rowid=2", "usage_counted_threads_rowid=1"]);
    store.close();
    const again = new SqliteStore(file);
    expect(again.usageAtStart.mode).toBe("none");
    expect(marks(again)).toEqual(["usage_counted_messages_rowid=2", "usage_counted_threads_rowid=1"]);
    again.close();
  });

  it("a counter edited by hand is put right by recomputeUsage, or by clearing mesh_meta and restarting; only wrong rows are written", async () => {
    const file = tmpFile();
    const { store: a, right } = await small(file);
    const bobUpdatedAt = (await a.getAgentByXUserId("2"))!.updated_at;
    rawOf(a).exec("update mesh_agents set stored_bytes = 999999 where x_user_id = '1'");
    expect(a.recomputeUsage()).toMatchObject({ mode: "full", agents: 2, corrected: 1 });
    expect({ alice: await used(a, "1"), bob: await used(a, "2") }).toEqual(right);
    expect(a.recomputeUsage().corrected).toBe(0);

    rawOf(a).exec("update mesh_agents set stored_bytes = 5 where x_user_id = '2'; delete from mesh_meta;");
    a.close();
    const b = new SqliteStore(file);
    expect(b.usageAtStart).toMatchObject({ mode: "full", agents: 2, corrected: 1 });
    expect({ alice: await used(b, "1"), bob: await used(b, "2") }).toEqual(right);
    expect((await b.getAgentByXUserId("2"))!.updated_at).toBe(bobUpdatedAt);
    expect(logged().filter((l) => l.includes("recomputed stored_bytes for 1 of 2 agents from the tables"))).toHaveLength(1);
    b.close();
  });

  it("marks that point past the end of a table (rows were removed by hand) cause a full recount", async () => {
    const file = tmpFile();
    const { store: a, threadId } = await small(file);
    await a.insertMessage({ thread_id: threadId, from_x_user_id: "2", kind: "update", message: msg("x".repeat(500)), needs_human: false });
    const withBig = await used(a, "2");
    rawOf(a).exec("delete from mesh_messages where rowid = 2");
    a.close();
    const b = new SqliteStore(file);
    expect(b.usageAtStart).toMatchObject({ mode: "full", corrected: 1 });
    expect(await used(b, "2")).toBe(messageBytes(msg("hi")));
    expect(await used(b, "2")).toBeLessThan(withBig);
    b.close();
  });

  it("a row written without being counted while this version runs makes the next start recount everything, exactly", async () => {
    const file = tmpFile();
    const { store: a, threadId, right } = await small(file);
    // The previous release, on the same file at the same time, inserts a message its own way.
    const old = new DatabaseSync(file);
    const uncounted = msg("from the old version");
    old.prepare("insert into mesh_messages (id, thread_id, from_x_user_id, kind, message, needs_human, created_at) values ('old-1', ?, '2', 'update', ?, 0, '2026-11-18T00:00:00.000Z')").run(threadId, JSON.stringify(uncounted));
    old.close();
    // This version then writes on top of it: the mark cannot move past the uncounted row.
    const mine = msg("from this version");
    await a.insertMessage({ thread_id: threadId, from_x_user_id: "2", kind: "update", message: mine, needs_human: false });
    expect(marks(a)).toEqual([]); // dropped: they could not be trusted any more
    expect(await used(a, "2")).toBe(right.bob + messageBytes(mine)); // the old row is not in yet
    a.close();
    const b = new SqliteStore(file);
    expect(b.usageAtStart).toMatchObject({ mode: "full", corrected: 1 });
    expect(await used(b, "2")).toBe(right.bob + messageBytes(mine) + messageBytes(uncounted)); // each row once
    expect(await used(b, "1")).toBe(right.alice);
    expect(marks(b)).toEqual(["usage_counted_messages_rowid=3", "usage_counted_threads_rowid=1"]);
    b.close();
  });
});

describe("SqliteStore: adding the counters to a database made by the previous release", () => {
  function legacyFile() {
    const file = tmpFile();
    const old = new LegacyDb(file);
    old.agent("1", "alice", { verified: true });
    old.agent("2", "bob");
    old.agent("3", "carol"); // has stored nothing
    const t1 = old.thread("1", ["1", "2"], "Plan the meetup — 計画", "active");
    const t2 = old.thread("2", ["2", "1", "3"], "second goal");
    old.message(t1, "1", "Plan the meetup — 計画", "proposal");
    old.message(t1, "2", "Accepted the goal.", "accept");
    old.message(t1, "2", "héllo 👋 " + "x".repeat(3000));
    old.message(t2, "2", "second goal", "proposal");
    const before = old.dump();
    // The expected numbers, by the documented formula, from the legacy rows themselves.
    const expected = new Map<string, number>([["1", 0], ["2", 0], ["3", 0]]);
    for (const t of before.threads as { proposer_x_user_id: string; goal: string; participants: string }[]) {
      expected.set(t.proposer_x_user_id, expected.get(t.proposer_x_user_id)! + threadBytes({ goal: t.goal, participants: JSON.parse(t.participants) as string[] }));
    }
    for (const m of before.messages as { from_x_user_id: string; message: string }[]) {
      expected.set(m.from_x_user_id, expected.get(m.from_x_user_id)! + messageBytes(JSON.parse(m.message) as Record<string, unknown>));
    }
    old.close();
    return { file, before, expected, t1 };
  }
  const columns = (file: string) => {
    const db = new DatabaseSync(file);
    try {
      return db.prepare("pragma table_info(mesh_agents)").all().map((c) => String(c.name));
    } finally {
      db.close();
    }
  };

  it("adds the column, fills it in from the existing rows by the documented formula, and changes nothing else", async () => {
    const { file, before, expected } = legacyFile();
    expect(columns(file)).not.toContain("stored_bytes");
    const s = new SqliteStore(file);
    for (const [id, want] of expected) expect(await used(s, id)).toBe(want);
    expect(expected.get("2")!).toBeGreaterThan(3000);
    expect(await used(s, "3")).toBe(0);
    expect(s.usageAtStart).toMatchObject({ mode: "full", agents: 3, corrected: 2 });
    // Everything that was there still reads as before.
    expect(await s.getAgentByKeyHash("hash-1")).toMatchObject({ x_handle: "alice", x_verified: true, owner_opt_in: true });
    s.close();
    expect(columns(file)).toContain("stored_bytes");
    expect(dumpFile(file)).toEqual(before); // every legacy column of every legacy row, byte for byte
  });

  it("is idempotent: later starts find nothing to do", async () => {
    const { file, before, expected } = legacyFile();
    new SqliteStore(file).close();
    errors.mockClear();
    for (let i = 0; i < 2; i++) {
      const s = new SqliteStore(file);
      expect(s.usageAtStart).toMatchObject({ mode: "none", corrected: 0 });
      for (const [id, want] of expected) expect(await used(s, id)).toBe(want);
      s.close();
    }
    expect(logged()).toEqual([]);
    expect(dumpFile(file)).toEqual(before);
    expect(columns(file).filter((c) => c === "stored_bytes")).toHaveLength(1);
  });

  it("the quota applies at once to what was stored before the upgrade", async () => {
    const { file, expected, t1 } = legacyFile();
    const s = new SqliteStore(file);
    const mesh = new Mesh(s, testConfig({ agentQuotaBytes: expected.get("2")! + 100 }));
    // The legacy rows hold key hashes, not keys: give bob a key this test knows.
    const { sha256 } = await import("../src/mesh.js");
    await s.updateAgent("2", { api_key_hash: sha256("bob-key") });
    const r = await call(mesh, { ip: "b", apiKey: "bob-key" }, "post_update", { thread_id: t1, text: "one more" });
    expect(r.body).toMatchObject({ error: "quota_exceeded", used_bytes: expected.get("2")! });
    s.close();
  });

  it("survives a roll-back: the previous release can use the upgraded file, and what it writes is counted at the next start", async () => {
    const { file, expected, t1 } = legacyFile();
    new SqliteStore(file).close();
    // The previous release opens the upgraded file and writes with its own statements (explicit
    // column lists, so the new column takes its default).
    const old = new LegacyDb(file);
    old.agent("4", "dave");
    old.message(t1, "1", "written by the old version");
    old.thread("4", ["4", "1"], "dave's goal");
    const rows = old.db.prepare("select x_user_id, stored_bytes from mesh_agents order by x_user_id").all();
    expect(rows.map((r) => Number(r.stored_bytes))).toEqual([expected.get("1"), expected.get("2"), 0, 0]); // the old version did not count
    old.close();
    const s = new SqliteStore(file);
    // Only the rows above the marks were read, and each was added once.
    expect(s.usageAtStart).toMatchObject({ mode: "delta", corrected: 2, agents: 4 });
    const oldMessage = JSON.parse(String(rawDump(file).messages.find((m: any) => String(m.message).includes("written by the old version")).message)) as Record<string, unknown>;
    expect(await used(s, "1")).toBe(expected.get("1")! + messageBytes(oldMessage));
    expect(await used(s, "4")).toBe(threadBytes({ goal: "dave's goal", participants: ["4", "1"] }));
    expect(await used(s, "2")).toBe(expected.get("2")!);
    expect(s.recomputeUsage().corrected).toBe(0); // a full recount agrees
    s.close();
    const again = new SqliteStore(file);
    expect(again.usageAtStart).toMatchObject({ mode: "none", corrected: 0 });
    again.close();
  });
});

describe.each([
  ["MemoryStore", () => new MemoryStore() as Store],
  ["SqliteStore", () => new SqliteStore(":memory:") as Store],
])("the quota on every write path: %s", (_name, make) => {
  const QUOTA = 6000;

  /** alice (1), bob (2), carol (3); an active thread between alice and bob. The quota is switched on afterwards. */
  async function setup(quota = QUOTA) {
    const store = make();
    const cfg = testConfig();
    const mesh = new Mesh(store, cfg);
    const alice = await register(mesh, "1", "alice");
    const bob = await register(mesh, "2", "bob");
    const carol = await register(mesh, "3", "carol");
    for (const a of [alice, bob, carol]) await call(mesh, a.ctx, "list_mutual_agents", { follower_ids: ["1", "2", "3"], following_ids: ["1", "2", "3"] });
    const p = await call(mesh, alice.ctx, "propose_goal", { goal: "Plan the meetup", participant_x_user_ids: ["2"] });
    const threadId: string = p.body.thread.thread_id;
    await call(mesh, bob.ctx, "accept_goal", { thread_id: threadId, accept: true });
    cfg.agentQuotaBytes = quota;
    return { store, mesh, alice, bob, carol, threadId };
  }
  /** Posts 1000-character updates as `who` until one is refused; returns that refusal. */
  async function fill(mesh: Mesh, who: TestAgent, threadId: string) {
    for (let i = 0; i < 100; i++) {
      const r = await call(mesh, who.ctx, "post_update", { thread_id: threadId, text: "x".repeat(1000) });
      if (r.isError) return r;
    }
    throw new Error("the quota never applied");
  }
  const snapshot = async (store: Store, threadId: string) => ({
    thread: await store.getThread(threadId),
    messages: (await store.listMessages(threadId, 200)).length,
    alice: await used(store, "1"),
    aliceThreads: (await store.listThreadsFor("1")).length,
    bobThreads: (await store.listThreadsFor("2")).length,
  });

  it("refuses a post over the quota with a clear, final error, and stores nothing", async () => {
    const { store, mesh, alice, threadId } = await setup();
    const refused = await fill(mesh, alice, threadId);
    const stored = await used(store, "1");
    expect(stored).toBeLessThanOrEqual(QUOTA);
    expect(stored).toBeGreaterThan(QUOTA - 1500); // it was allowed right up to the quota
    expect(refused.body).toEqual({
      error: "quota_exceeded",
      message: expect.stringMatching(/storage quota on this mesh is used up \(\d+ KB stored, quota 6 KB\)\. Nothing was stored\. The quota does not refill/),
      used_bytes: stored,
      quota_bytes: QUOTA,
    });
    expect(refused.body.retry_after_seconds).toBeUndefined(); // not a rate limit: waiting does not help
    const before = await snapshot(store, threadId);
    for (let i = 0; i < 3; i++) expect((await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "x".repeat(1000) })).body.error).toBe("quota_exceeded");
    expect(await snapshot(store, threadId)).toEqual(before);
    expect(logged()).toEqual([]);
  });

  it("applies to propose_goal (no thread appears), escalate_to_human (the thread keeps its status) and propose_payment", async () => {
    const { store, mesh, alice, threadId } = await setup();
    await fill(mesh, alice, threadId);
    const before = await snapshot(store, threadId);
    expect(before.thread!.status).toBe("active");

    const proposed = await call(mesh, alice.ctx, "propose_goal", { goal: "g".repeat(1000), participant_x_user_ids: ["3"] });
    expect(proposed.body.error).toBe("quota_exceeded");
    const escalated = await call(mesh, alice.ctx, "escalate_to_human", { thread_id: threadId, question: "q".repeat(900) });
    expect(escalated.body.error).toBe("quota_exceeded");
    const needsHuman = await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "t".repeat(900), needs_human: true });
    expect(needsHuman.body.error).toBe("quota_exceeded");
    const withData = await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "d", data: { blob: "y".repeat(2000) } });
    expect(withData.body.error).toBe("quota_exceeded");
    // A payment draft is a few hundred bytes: fill the last of the quota with small posts first.
    while (!(await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "s" })).isError);
    const full = await snapshot(store, threadId);
    const payment = await call(mesh, alice.ctx, "propose_payment", { thread_id: threadId, to_x_handle: "bob", amount: 5, memo: "m".repeat(200) });
    expect(payment.body.error).toBe("quota_exceeded");

    expect(await snapshot(store, threadId)).toEqual(full);
    expect(full.thread).toEqual(before.thread); // still active, not input_required
    expect(full.aliceThreads).toBe(1);
    expect((await store.listThreadsFor("3")).length).toBe(0);
  });

  it("applies to A2A message/send (new proposal and existing task) with its own error code, HTTP 200", async () => {
    const { store, mesh, alice, threadId } = await setup();
    await fill(mesh, alice, threadId);
    const before = await snapshot(store, threadId);
    const send = (message: Record<string, unknown>) => handleA2A(mesh, alice.ctx, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "message/send", params: { message: { role: "agent", messageId: "m1", parts: [{ kind: "text", text: "z".repeat(1000) }], ...message } } }));
    for (const out of [await send({ taskId: threadId }), await send({ metadata: { to_x_user_id: "3" } })]) {
      expect(out.status).toBe(200);
      expect(out.headers?.["Retry-After"]).toBeUndefined();
      expect(out.body).toEqual({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32012, message: "Storage quota exceeded", data: { detail: expect.stringContaining("storage quota on this mesh is used up"), used_bytes: before.alice, quota_bytes: QUOTA } },
      });
    }
    expect(await snapshot(store, threadId)).toEqual(before);
  });

  it("is per agent, and reads are never affected", async () => {
    const { mesh, alice, bob, threadId } = await setup();
    await fill(mesh, alice, threadId);
    expect((await call(mesh, bob.ctx, "post_update", { thread_id: threadId, text: "x".repeat(1000) })).isError).toBe(false);
    const list = await call(mesh, alice.ctx, "list_threads");
    expect(list.isError).toBe(false);
    expect(list.body.storage).toEqual({ used_bytes: expect.any(Number), quota_bytes: QUOTA });
    expect(list.body.storage.used_bytes).toBeGreaterThan(QUOTA - 1500);
    expect((await call(mesh, alice.ctx, "read_thread", { thread_id: threadId })).isError).toBe(false);
    expect((await call(mesh, alice.ctx, "list_mutual_agents", { follower_ids: ["2"], following_ids: ["2"] })).isError).toBe(false);
    const task = await handleA2A(mesh, alice.ctx, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: threadId } }));
    expect((task.body as any).result.id).toBe(threadId);
  });

  it("a full agent can still accept, decline, complete and cancel (a bounded reserve)", async () => {
    const { store, mesh, alice, bob, carol, threadId } = await setup();
    // Two proposals to alice while she still has room to be named (being named costs her nothing).
    const p1 = (await call(mesh, bob.ctx, "propose_goal", { goal: "to accept", participant_x_user_ids: ["1"] })).body.thread.thread_id as string;
    const p2 = (await call(mesh, carol.ctx, "propose_goal", { goal: "to decline", participant_x_user_ids: ["1"] })).body.thread.thread_id as string;
    const p3 = (await call(mesh, bob.ctx, "propose_goal", { goal: "to cancel", participant_x_user_ids: ["1"] })).body.thread.thread_id as string;
    await fill(mesh, alice, threadId);
    while (!(await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "s" })).isError);
    expect((await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "s" })).body.error).toBe("quota_exceeded");

    expect((await call(mesh, alice.ctx, "accept_goal", { thread_id: p1, accept: true })).body.thread.status).toBe("active");
    expect((await call(mesh, alice.ctx, "accept_goal", { thread_id: p2, accept: false })).body.thread.status).toBe("declined");
    const canceled = await handleA2A(mesh, alice.ctx, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/cancel", params: { id: p3 } }));
    expect((canceled.body as any).result.status.state).toBe("canceled");
    expect((await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "Done.", set_status: "completed" })).body.thread.status).toBe("completed");
    // Those records are counted too...
    expect(await used(store, "1")).toBeGreaterThan(QUOTA);
    // ...and an ordinary post is still refused.
    expect((await call(mesh, alice.ctx, "post_update", { thread_id: p1, text: "s" })).body.error).toBe("quota_exceeded");
  });

  it("the reserve is bounded: control records stop at quota + 64 KB", async () => {
    const { store, mesh, alice, bob, threadId } = await setup();
    await fill(mesh, alice, threadId);
    // A proposed thread can be accepted again and again by the same agent; each stores a record.
    const p = (await call(mesh, bob.ctx, "propose_goal", { goal: "g", participant_x_user_ids: ["1", "3"] })).body.thread.thread_id as string;
    let accepted = 0;
    let refused: any = null;
    for (let i = 0; i < 1000 && !refused; i++) {
      const r = await call(mesh, alice.ctx, "accept_goal", { thread_id: p, accept: true });
      if (r.isError) refused = r.body;
      else accepted++;
    }
    expect(refused).toMatchObject({ error: "quota_exceeded", quota_bytes: QUOTA });
    expect(accepted).toBeGreaterThan(50);
    const total = await used(store, "1");
    expect(total).toBeLessThanOrEqual(QUOTA + LIMITS.quotaControlReserveBytes);
    expect(total).toBeGreaterThan(QUOTA + LIMITS.quotaControlReserveBytes - 1000);
    // Now nothing at all can be written by this agent, not even a cancel.
    const cancel = await handleA2A(mesh, alice.ctx, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/cancel", params: { id: p } }));
    expect((cancel.body as any).error.code).toBe(-32012);
    expect((await store.getThread(p))!.status).toBe("proposed");
    expect(await used(store, "1")).toBe(total);
  });

  it("concurrent posts by one agent cannot pass the quota together", async () => {
    const { store, mesh, alice, threadId } = await setup(20_000);
    const results = await Promise.all(Array.from({ length: 40 }, () => call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "x".repeat(1000) })));
    const ok = results.filter((r) => !r.isError).length;
    expect(ok).toBeGreaterThan(5);
    expect(ok).toBeLessThan(40);
    for (const r of results) if (r.isError) expect(r.body.error).toBe("quota_exceeded");
    expect(await used(store, "1")).toBeLessThanOrEqual(20_000);
    expect((await store.listMessages(threadId, 200)).filter((m) => m.kind === "update")).toHaveLength(ok);
  });

  it("a proposal is refused whole when the thread would fit but its first message would not", async () => {
    const { store, mesh, alice, threadId } = await setup();
    await fill(mesh, alice, threadId);
    const room = QUOTA - (await used(store, "1"));
    // Choose a goal whose thread row fits in the room left, while thread + first message does not.
    const goal = "g".repeat(Math.max(1, Math.min(2000, room - 300)));
    if (threadBytes({ goal, participants: ["1", "3"] }) <= room) {
      const r = await call(mesh, alice.ctx, "propose_goal", { goal, participant_x_user_ids: ["3"] });
      expect(r.body.error).toBe("quota_exceeded");
    }
    expect((await store.listThreadsFor("1")).length).toBe(1);
    expect((await store.listThreadsFor("3")).length).toBe(0);
  });

  it("MESH_AGENT_QUOTA_KB=0 means no quota", async () => {
    const { store, mesh, alice, threadId } = await setup(0);
    for (let i = 0; i < 30; i++) expect((await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "x".repeat(1000) })).isError).toBe(false);
    expect(await used(store, "1")).toBeGreaterThan(30_000);
    expect((await call(mesh, alice.ctx, "list_threads")).body.storage).toEqual({ used_bytes: await used(store, "1"), quota_bytes: null });
  });

  it("what an agent has stored is shown only to that agent", async () => {
    const { mesh, alice, bob, threadId } = await setup();
    await fill(mesh, alice, threadId);
    const seen = [
      await call(mesh, bob.ctx, "list_mutual_agents", { follower_ids: ["1", "3"], following_ids: ["1", "3"] }),
      await call(mesh, bob.ctx, "read_thread", { thread_id: threadId }),
    ];
    for (const r of seen) expect(JSON.stringify(r.body)).not.toMatch(/stored_bytes|used_bytes|quota_bytes/);
    expect((await call(mesh, bob.ctx, "list_threads")).body.storage.used_bytes).toBeLessThan(1000); // bob's own number
  });
});

describe("the quota survives a restart (the in-memory write budget does not)", () => {
  it("an agent that filled its quota is still full after the server restarts on the same file", async () => {
    const file = tmpFile();
    const cfg = () => testConfig({ agentQuotaBytes: 8000, writeRate: { capacity: 1_000_000, refillPerSec: 1 } });
    const first = new SqliteStore(file);
    const mesh1 = new Mesh(first, cfg());
    const alice = await register(mesh1, "1", "alice");
    const bob = await register(mesh1, "2", "bob");
    await call(mesh1, alice.ctx, "list_mutual_agents", { follower_ids: ["2"], following_ids: ["2"] });
    const threadId = (await call(mesh1, alice.ctx, "propose_goal", { goal: "g", participant_x_user_ids: ["2"] })).body.thread.thread_id as string;
    await call(mesh1, bob.ctx, "accept_goal", { thread_id: threadId, accept: true });
    let refused: any = null;
    while (!refused) {
      const r = await call(mesh1, alice.ctx, "post_update", { thread_id: threadId, text: "x".repeat(1000) });
      if (r.isError) refused = r.body;
    }
    expect(refused.error).toBe("quota_exceeded");
    const stored = await used(first, "1");
    first.close();

    // A new process: new Mesh (fresh in-memory limiters), same file.
    const second = new SqliteStore(file);
    const mesh2 = new Mesh(second, cfg());
    expect(await used(second, "1")).toBe(stored);
    const again = await call(mesh2, alice.ctx, "post_update", { thread_id: threadId, text: "x".repeat(1000) });
    expect(again.body).toMatchObject({ error: "quota_exceeded", used_bytes: stored, quota_bytes: 8000 });
    expect((await call(mesh2, bob.ctx, "post_update", { thread_id: threadId, text: "still fine" })).isError).toBe(false);
    second.close();

    // The operator raises the quota: the agent can write again, counted from where it was.
    const third = new SqliteStore(file);
    const mesh3 = new Mesh(third, testConfig({ agentQuotaBytes: 16_000 }));
    expect((await call(mesh3, alice.ctx, "post_update", { thread_id: threadId, text: "x".repeat(1000) })).isError).toBe(false);
    expect(await used(third, "1")).toBeGreaterThan(stored);
    third.close();
  });

  it("re-registering (key rotation, rename) does not reset what an agent has stored", async () => {
    const store = new SqliteStore(":memory:");
    const mesh = new Mesh(store, testConfig({ agentQuotaBytes: 8000 }));
    const alice = await register(mesh, "1", "alice");
    await register(mesh, "2", "bob");
    await call(mesh, alice.ctx, "list_mutual_agents", { follower_ids: ["2"], following_ids: ["2"] });
    await call(mesh, alice.ctx, "propose_goal", { goal: "g".repeat(500), participant_x_user_ids: ["2"] });
    const before = await used(store, "1");
    expect(before).toBeGreaterThan(1000);
    const rotated = await call(mesh, alice.ctx, "register_agent", { x_user_id: "1", x_handle: "alice_renamed", owner_opt_in: true });
    expect(rotated.body.rotated).toBe(true);
    expect(await used(store, "1")).toBe(before);
    store.close();
  });
});

describe("configuration", () => {
  it("MESH_AGENT_QUOTA_KB: 10 MB by default, 0 turns it off, never less than one maximal message", () => {
    expect(loadConfig({}).agentQuotaBytes).toBe(10 * 1024 * 1024);
    expect(loadConfig({ MESH_AGENT_QUOTA_KB: "" }).agentQuotaBytes).toBe(10 * 1024 * 1024);
    expect(loadConfig({ MESH_AGENT_QUOTA_KB: "0" }).agentQuotaBytes).toBe(0);
    expect(loadConfig({ MESH_AGENT_QUOTA_KB: " 0 " }).agentQuotaBytes).toBe(0);
    expect(loadConfig({ MESH_AGENT_QUOTA_KB: "2048" }).agentQuotaBytes).toBe(2048 * 1024);
    expect(loadConfig({ MESH_AGENT_QUOTA_KB: "1" }).agentQuotaBytes).toBe(LIMITS.minWriteBurstBytes);
    expect(loadConfig({ MESH_AGENT_QUOTA_KB: "0.5" }).agentQuotaBytes).toBe(LIMITS.minWriteBurstBytes);
    for (const bad of ["-1", "abc", "1e999", "10MB"]) expect(() => loadConfig({ MESH_AGENT_QUOTA_KB: bad })).toThrow(/MESH_AGENT_QUOTA_KB must be a positive number/);
    // The default is modest next to the 1 GB volume: a hundred agents at their quota fit.
    expect(loadConfig({}).agentQuotaBytes * 100).toBeLessThanOrEqual(1024 ** 3);
  });
});

describe("SupabaseStore (mocked client): the limit is read from the agent row", () => {
  function mock(results: { data: unknown; error: null }[]) {
    const queries: { table: string; calls: unknown[][] }[] = [];
    const db = {
      from(table: string) {
        const q = { table, calls: [] as unknown[][] };
        queries.push(q);
        const b: any = new Proxy({}, {
          get(_t, prop: string) {
            if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(results.shift() ?? { data: null, error: null }).then(ok);
            return (...args: unknown[]) => {
              q.calls.push([prop, ...args]);
              return b;
            };
          },
        });
        return b;
      },
    };
    return { store: new SupabaseStore(db as unknown as SupabaseClient), queries };
  }
  const m = { thread_id: "t", from_x_user_id: "1", kind: "update" as const, message: { kind: "message" }, needs_human: false };

  it("refuses a write that would pass the limit, without inserting", async () => {
    const { store, queries } = mock([{ data: { x_user_id: "1", stored_bytes: 5000 }, error: null }]);
    const err = await store.insertMessage(m, { limitBytes: 5100 }).catch((e: unknown) => e);
    expect((err as StoreError).code).toBe("quota_exceeded");
    expect((err as StoreError).usage).toEqual({ usedBytes: 5000, neededBytes: messageBytes(m.message), limitBytes: 5100 });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual({ table: "mesh_agents", calls: [["select", "*"], ["eq", "x_user_id", "1"], ["maybeSingle"]] });
  });

  it("lets a write in under the limit, and treats a database without the column as nothing stored", async () => {
    const under = mock([{ data: { x_user_id: "1", stored_bytes: "100" }, error: null }, { data: { id: "m" }, error: null }]);
    expect(await under.store.insertMessage(m, { limitBytes: 5000 })).toEqual({ id: "m" });
    expect(under.queries.map((q) => q.table)).toEqual(["mesh_agents", "mesh_messages"]);
    const noColumn = mock([{ data: { x_user_id: "1" }, error: null }, { data: { id: "t" }, error: null }]);
    expect(await noColumn.store.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1"], accepted_by: ["1"], status: "proposed" }, { limitBytes: 5000 })).toEqual({ id: "t" });
    // Without a limit the query shape is what it always was: one insert.
    const plain = mock([{ data: { id: "m" }, error: null }]);
    await plain.store.insertMessage(m);
    expect(plain.queries).toEqual([{ table: "mesh_messages", calls: [["insert", m], ["select", "*"], ["single"]] }]);
  });

  it("the mesh reads a missing stored_bytes as 0 and keeps working", async () => {
    const store = new MemoryStore();
    const mesh = new Mesh(store, testConfig({ agentQuotaBytes: 100_000 }));
    const alice = await register(mesh, "1", "alice");
    const real = store.getAgentByKeyHash.bind(store);
    store.getAgentByKeyHash = async (h) => {
      const a = await real(h);
      if (a) delete (a as { stored_bytes?: number }).stored_bytes;
      return a;
    };
    expect((await call(mesh, alice.ctx, "list_threads")).body.storage).toEqual({ used_bytes: 0, quota_bytes: 100_000 });
  });
});
