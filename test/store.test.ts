import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testConfig } from "../src/config.js";
import { Mesh } from "../src/mesh.js";
import { createStore, MemoryStore, SqliteStore, type NewAgent, type Store } from "../src/store.js";
import { activeThread, call } from "./helpers.js";

const tmp = mkdtempSync(join(tmpdir(), "x-agent-mesh-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let files = 0;
const tmpFile = () => join(tmp, `mesh-${++files}.db`);

const newAgent = (id: string, handle: string, over: Partial<NewAgent> = {}): NewAgent => ({
  x_user_id: id,
  x_handle: handle,
  agent_card_url: null,
  display_name: null,
  owner_opt_in: true,
  opted_in_at: "2026-11-16T00:00:00.000Z",
  api_key_hash: `hash-${id}`,
  ...over,
});

const STORES: [string, () => Store][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["SqliteStore (:memory:)", () => new SqliteStore(":memory:")],
  ["SqliteStore (file)", () => new SqliteStore(tmpFile())],
];

describe.each(STORES)("Store behaviour: %s", (_name, make) => {
  it("stores agents and finds them by id, handle (any case) and key hash", async () => {
    const s = make();
    const a = await s.insertAgent(newAgent("1", "Alice_A", { display_name: "Alice", agent_card_url: "https://a.example/card.json" }));
    expect(a).toMatchObject({ x_user_id: "1", x_handle: "Alice_A", display_name: "Alice", agent_card_url: "https://a.example/card.json", owner_opt_in: true, x_verified: false, api_key_hash: "hash-1" });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.created_at).toBe(a.updated_at);
    expect(new Date(a.created_at).toISOString()).toBe(a.created_at);

    expect(await s.getAgentByXUserId("1")).toEqual(a);
    expect(await s.getAgentByHandle("alice_a")).toEqual(a);
    expect(await s.getAgentByHandle("ALICE_A")).toEqual(a);
    expect(await s.getAgentByHandle("aliceXa")).toBeNull(); // `_` is not a wildcard
    expect(await s.getAgentByKeyHash("hash-1")).toEqual(a);
    expect(await s.getAgentByXUserId("nope")).toBeNull();
    expect(await s.getAgentByHandle("nope")).toBeNull();
    expect(await s.getAgentByKeyHash("nope")).toBeNull();
  });

  it("persists x_verified through updateAgent and leaves it alone otherwise", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    expect((await s.updateAgent("1", { x_verified: true, x_handle: "Alice2" })).x_verified).toBe(true);
    expect(await s.getAgentByXUserId("1")).toMatchObject({ x_verified: true, x_handle: "Alice2" });
    expect((await s.updateAgent("1", { display_name: "A" })).x_verified).toBe(true);
    expect((await s.updateAgent("1", { x_verified: false })).x_verified).toBe(false);
  });

  it("refuses a second agent with the same x_user_id", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    await expect(s.insertAgent(newAgent("1", "alice2"))).rejects.toThrow();
    expect((await s.getAgentByXUserId("1"))!.x_handle).toBe("alice");
  });

  it("updates an agent, leaving unpatched fields alone", async () => {
    const s = make();
    const a = await s.insertAgent(newAgent("1", "alice", { display_name: "Alice" }));
    const b = await s.updateAgent("1", { owner_opt_in: false, opted_in_at: null, api_key_hash: "rotated" });
    expect(b).toMatchObject({ id: a.id, x_handle: "alice", display_name: "Alice", owner_opt_in: false, opted_in_at: null, api_key_hash: "rotated", created_at: a.created_at });
    expect(b.updated_at > a.updated_at).toBe(true);
    expect(await s.getAgentByKeyHash("hash-1")).toBeNull();
    expect(await s.getAgentByKeyHash("rotated")).toEqual(b);
    await expect(s.updateAgent("missing", { display_name: "x" })).rejects.toThrow();
  });

  it("getOptedInAgents returns only opted-in agents among the ids asked for", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    await s.insertAgent(newAgent("2", "bob", { owner_opt_in: false, opted_in_at: null }));
    await s.insertAgent(newAgent("3", "carol"));
    await s.insertAgent(newAgent("4", "dave"));
    const got = await s.getOptedInAgents(["1", "2", "3", "3", "99"]);
    expect(got.map((a) => a.x_user_id).sort()).toEqual(["1", "3"]);
    expect(await s.getOptedInAgents([])).toEqual([]);
    const many = Array.from({ length: 5000 }, (_, i) => String(i + 100)).concat("4");
    expect((await s.getOptedInAgents(many)).map((a) => a.x_user_id)).toEqual(["4"]);
  });

  it("stores threads, with compare-and-set updates", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    const t = await s.insertThread({ goal: "Plan the meetup", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    expect(t).toMatchObject({ goal: "Plan the meetup", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    expect(t.created_at).toBe(t.updated_at);
    expect(await s.getThread(t.id)).toEqual(t);
    expect(await s.getThread("00000000-0000-0000-0000-000000000000")).toBeNull();

    const u = await s.updateThread(t.id, { accepted_by: ["1", "2"], status: "active" }, t.updated_at);
    expect(u).toMatchObject({ id: t.id, goal: "Plan the meetup", accepted_by: ["1", "2"], status: "active", created_at: t.created_at });
    expect(u!.updated_at > t.updated_at).toBe(true);
    expect(await s.getThread(t.id)).toEqual(u);

    // A writer still holding the old stamp loses, and nothing changes.
    expect(await s.updateThread(t.id, { status: "canceled" }, t.updated_at)).toBeNull();
    expect(await s.getThread(t.id)).toEqual(u);
    expect(await s.updateThread("00000000-0000-0000-0000-000000000000", { status: "canceled" }, u!.updated_at)).toBeNull();

    // A partial patch keeps the other field.
    const v = await s.updateThread(t.id, { status: "completed" }, u!.updated_at);
    expect(v).toMatchObject({ status: "completed", accepted_by: ["1", "2"] });
  });

  it("only one of two concurrent compare-and-set updates wins", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    const t = await s.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1", "2", "3"], accepted_by: ["1"], status: "proposed" });
    const [a, b] = await Promise.all([
      s.updateThread(t.id, { accepted_by: ["1", "2"] }, t.updated_at),
      s.updateThread(t.id, { accepted_by: ["1", "3"] }, t.updated_at),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await s.getThread(t.id))!.accepted_by).toEqual((a ?? b)!.accepted_by);
  });

  it("lists a participant's threads, most recently updated first, optionally by status", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    const t1 = await s.insertThread({ goal: "one", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    const t2 = await s.insertThread({ goal: "two", proposer_x_user_id: "1", participants: ["1", "3"], accepted_by: ["1"], status: "proposed" });
    const t3 = await s.insertThread({ goal: "three", proposer_x_user_id: "1", participants: ["1", "2", "3"], accepted_by: ["1"], status: "proposed" });
    expect((await s.listThreadsFor("1")).map((t) => t.goal)).toEqual(["three", "two", "one"]);
    expect((await s.listThreadsFor("2")).map((t) => t.id)).toEqual([t3.id, t1.id]);
    expect(await s.listThreadsFor("12")).toEqual([]); // membership, not substring

    await s.updateThread(t1.id, { status: "active" }, t1.updated_at);
    expect((await s.listThreadsFor("1")).map((t) => t.goal)).toEqual(["one", "three", "two"]);
    expect((await s.listThreadsFor("1", "active")).map((t) => t.id)).toEqual([t1.id]);
    expect((await s.listThreadsFor("3", "proposed")).map((t) => t.id)).toEqual([t3.id, t2.id]);
    expect(await s.listThreadsFor("3", "completed")).toEqual([]);
  });

  it("caps a thread list at 100", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    for (let i = 0; i < 103; i++) await s.insertThread({ goal: `g${i}`, proposer_x_user_id: "1", participants: ["1"], accepted_by: ["1"], status: "proposed" });
    const list = await s.listThreadsFor("1");
    expect(list).toHaveLength(100);
    expect(list[0]!.goal).toBe("g102");
  });

  it("stores messages and returns the latest N, oldest first", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    const t = await s.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    const other = await s.insertThread({ goal: "h", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    const body = { kind: "message", role: "agent", parts: [{ kind: "text", text: "héllo ‮ \"quoted\"" }], nested: { n: 1, list: [true, null] } };
    const first = await s.insertMessage({ thread_id: t.id, from_x_user_id: "1", kind: "proposal", message: body, needs_human: false });
    expect(first).toMatchObject({ thread_id: t.id, from_x_user_id: "1", kind: "proposal", message: body, needs_human: false });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    const fixed = await s.insertMessage({ id: "11111111-1111-4111-8111-111111111111", thread_id: t.id, from_x_user_id: "2", kind: "escalation", message: { n: 2 }, needs_human: true });
    expect(fixed).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", needs_human: true, kind: "escalation" });
    for (let i = 3; i <= 6; i++) await s.insertMessage({ thread_id: t.id, from_x_user_id: "1", kind: "update", message: { n: i }, needs_human: false });
    await s.insertMessage({ thread_id: other.id, from_x_user_id: "1", kind: "update", message: { n: 99 }, needs_human: false });

    const all = await s.listMessages(t.id, 50);
    expect(all).toHaveLength(6);
    expect(all[0]).toEqual(first);
    expect(all[1]).toEqual(fixed);
    expect(all.map((m) => m.created_at)).toEqual(all.map((m) => m.created_at).sort());
    expect((await s.listMessages(t.id, 3)).map((m) => m.message.n)).toEqual([4, 5, 6]);
    expect((await s.listMessages(other.id, 50)).map((m) => m.message.n)).toEqual([99]);
    expect(await s.listMessages("00000000-0000-0000-0000-000000000000", 50)).toEqual([]);
  });

  it("returns copies: changing a result does not change the store", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    const t = await s.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    t.participants.push("666");
    t.status = "completed";
    expect(await s.getThread(t.id)).toMatchObject({ participants: ["1", "2"], status: "proposed" });
  });

  it("runs the whole mesh flow (register, propose, accept, update, read)", async () => {
    const mesh = new Mesh(make(), testConfig());
    const { alice, bob, threadId } = await activeThread(mesh);
    const posted = await call(mesh, bob.ctx, "post_update", { thread_id: threadId, text: "Booked the room" });
    expect(posted.isError).toBe(false);
    const read = await call(mesh, alice.ctx, "read_thread", { thread_id: threadId });
    expect(read.isError).toBe(false);
    expect(read.body.thread.status).toBe("active");
    expect(JSON.stringify(read.body)).toContain("Booked the room");
  });
});

describe("SqliteStore", () => {
  it("keeps its data across close and reopen of the same file", async () => {
    const file = tmpFile();
    const a = new SqliteStore(file);
    const agent = await a.insertAgent(newAgent("1", "alice"));
    await a.insertAgent(newAgent("2", "bob"));
    const t0 = await a.insertThread({ goal: "Plan the meetup", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    const thread = (await a.updateThread(t0.id, { accepted_by: ["1", "2"], status: "active" }, t0.updated_at))!;
    const msg = await a.insertMessage({ thread_id: thread.id, from_x_user_id: "2", kind: "accept", message: { parts: [{ kind: "text", text: "in" }] }, needs_human: false });
    a.close();
    expect(existsSync(file)).toBe(true);

    const b = new SqliteStore(file); // schema creation is idempotent
    expect(b.kind).toBe("sqlite");
    expect(await b.getAgentByKeyHash("hash-1")).toEqual(agent);
    expect(await b.getThread(thread.id)).toEqual(thread);
    expect(await b.listThreadsFor("2", "active")).toEqual([thread]);
    expect(await b.listMessages(thread.id, 10)).toEqual([msg]);
    // The old stamp is still stale after a restart; the current one still works.
    expect(await b.updateThread(thread.id, { status: "canceled" }, t0.updated_at)).toBeNull();
    const done = await b.updateThread(thread.id, { status: "completed" }, thread.updated_at);
    expect(done!.updated_at > thread.updated_at).toBe(true);
    b.close();
  });

  it("two connections to one file see each other's writes, and compare-and-set holds across them", async () => {
    const file = tmpFile();
    const a = new SqliteStore(file);
    const b = new SqliteStore(file);
    await a.insertAgent(newAgent("1", "alice"));
    const t = await a.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"], status: "proposed" });
    expect(await b.getThread(t.id)).toEqual(t);
    const won = await b.updateThread(t.id, { status: "active" }, t.updated_at);
    expect(won!.status).toBe("active");
    expect(await a.updateThread(t.id, { status: "declined" }, t.updated_at)).toBeNull();
    expect((await a.getThread(t.id))!.status).toBe("active");
    a.close();
    b.close();
  });

  it("enforces the constraints: status and kind checks, foreign keys, cascade delete", async () => {
    const s = new SqliteStore(":memory:");
    await s.insertAgent(newAgent("1", "alice"));
    const t = await s.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1"], accepted_by: ["1"], status: "proposed" });
    const fail = /^The mesh database is unavailable or rejected the request\.$/;
    await expect(s.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1"], accepted_by: [], status: "bogus" as never })).rejects.toThrow(fail);
    await expect(s.insertThread({ goal: "", proposer_x_user_id: "1", participants: ["1"], accepted_by: [], status: "proposed" })).rejects.toThrow(fail);
    await expect(s.insertThread({ goal: "g", proposer_x_user_id: "ghost", participants: ["1"], accepted_by: [], status: "proposed" })).rejects.toThrow(fail);
    await expect(s.updateThread(t.id, { status: "bogus" as never }, t.updated_at)).rejects.toThrow(fail);
    await expect(s.insertMessage({ thread_id: t.id, from_x_user_id: "1", kind: "bogus" as never, message: {}, needs_human: false })).rejects.toThrow(fail);
    await expect(s.insertMessage({ thread_id: "no-such-thread", from_x_user_id: "1", kind: "update", message: {}, needs_human: false })).rejects.toThrow(fail);

    await s.insertMessage({ thread_id: t.id, from_x_user_id: "1", kind: "update", message: {}, needs_human: false });
    const db = (s as unknown as { db: { exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown> | undefined; all(): Record<string, unknown>[] } } }).db;
    expect(db.prepare("pragma foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(db.prepare("pragma index_list('mesh_agents')").all().map((r) => r.name)).toContain("mesh_agents_api_key_hash_idx");
    db.exec("delete from mesh_agents where x_user_id = '1'");
    expect(await s.getThread(t.id)).toBeNull();
    expect(await s.listMessages(t.id, 10)).toEqual([]);
    s.close();
  });

  it("uses WAL mode on a file and creates missing directories", async () => {
    const file = join(tmp, "nested", "deeper", "mesh.db");
    const s = new SqliteStore(file);
    expect(s.path).toBe(file);
    expect(existsSync(file)).toBe(true);
    const db = (s as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> | undefined } } }).db;
    expect(db.prepare("pragma journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    s.close();
  });
});

describe("createStore: SQLite default", () => {
  it("opens SQLite at MESH_SQLITE_PATH unless Supabase or MESH_STORE=memory is configured", () => {
    const file = join(tmp, "from-env", "mesh.db");
    const s = createStore({ MESH_SQLITE_PATH: file });
    expect(s).toBeInstanceOf(SqliteStore);
    expect((s as SqliteStore).path).toBe(file);
    expect(existsSync(file)).toBe(true);
    (s as SqliteStore).close();
    // Half a Supabase configuration is not Supabase.
    const half = createStore({ SUPABASE_URL: "https://example.supabase.co", MESH_SQLITE_PATH: file });
    expect(half).toBeInstanceOf(SqliteStore);
    (half as SqliteStore).close();
  });

  it("defaults to ./data/mesh.db under the working directory", () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmp, "cwd-"));
    process.chdir(dir);
    try {
      const s = createStore({}) as SqliteStore;
      expect(s).toBeInstanceOf(SqliteStore);
      expect(existsSync(join(dir, "data", "mesh.db"))).toBe(true);
      s.close();
    } finally {
      process.chdir(cwd);
    }
  });
});
