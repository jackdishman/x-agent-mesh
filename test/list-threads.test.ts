// list_threads without a full scan: SQLite keeps one row per (participant, thread) and the memory
// store an index by participant. The results must be exactly what the previous release returned;
// the previous release's query is kept here as the reference.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testConfig } from "../src/config.js";
import { Mesh } from "../src/mesh.js";
import { MemoryStore, SqliteStore, type Store, type Thread, type ThreadStatus } from "../src/store.js";
import { call, register } from "./helpers.js";
import { dumpFile, LegacyDb } from "./legacy-schema.js";

const tmp = mkdtempSync(join(tmpdir(), "x-agent-mesh-threads-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let files = 0;
const tmpFile = () => join(tmp, `mesh-${++files}.db`);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());
const logged = (): string[] => errors.mock.calls.map((c: unknown[]) => c.map(String).join(" "));

const STATUSES: ThreadStatus[] = ["proposed", "active", "input_required", "completed", "declined", "canceled"];

/** A small deterministic generator, so a failure can be reproduced. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type RawDb = DatabaseSync;
const rawOf = (s: SqliteStore) => (s as unknown as { db: RawDb }).db;

/** The previous release's listThreadsFor, word for word: a scan with json_each per thread. */
function legacyList(db: RawDb, xUserId: string, status?: ThreadStatus): string[] {
  const member = "exists (select 1 from json_each(mesh_threads.participants) where value = ?)";
  const rows = status
    ? db.prepare(`select * from mesh_threads where ${member} and status = ? order by updated_at desc, rowid desc limit 100`).all(xUserId, status)
    : db.prepare(`select * from mesh_threads where ${member} order by updated_at desc, rowid desc limit 100`).all(xUserId);
  return rows.map((r) => String(r.id));
}

/** The previous release's MemoryStore.listThreadsFor, over a list of all threads in insertion order. */
function legacyMemoryList(all: Thread[], xUserId: string, status?: ThreadStatus): string[] {
  return all
    .filter((t) => t.participants.includes(xUserId) && (!status || t.status === status))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 100)
    .map((t) => t.id);
}

/** 400 threads among 12 agents with random participants, then random status changes (which reorder the lists). */
async function populate(store: Store, seed: number): Promise<{ users: string[]; threads: Map<string, Thread> }> {
  const rand = rng(seed);
  const users = Array.from({ length: 12 }, (_, i) => String(i + 1));
  for (const u of users) await store.insertAgent({ x_user_id: u, x_handle: `user${u}`, agent_card_url: null, display_name: null, owner_opt_in: true, opted_in_at: null, api_key_hash: `h${u}` });
  const threads = new Map<string, Thread>();
  for (let i = 0; i < 400; i++) {
    const proposer = users[Math.floor(rand() * users.length)]!;
    // User "1" is in most threads (so the cap of 100 is hit); the others in a few.
    const others = users.filter((u) => u !== proposer && rand() < (u === "1" ? 0.7 : 0.12));
    const t = await store.insertThread({ goal: `goal ${i}`, proposer_x_user_id: proposer, participants: [proposer, ...others], accepted_by: [proposer], status: "proposed" });
    threads.set(t.id, t);
  }
  const ids = [...threads.keys()];
  for (let i = 0; i < 600; i++) {
    const id = ids[Math.floor(rand() * ids.length)]!;
    const current = threads.get(id)!;
    const updated = await store.updateThread(id, { status: STATUSES[Math.floor(rand() * STATUSES.length)]! }, current.updated_at);
    threads.set(id, updated!);
  }
  return { users, threads };
}

describe("listThreadsFor returns exactly what the previous release returned", () => {
  it.each([1, 2, 3])("SqliteStore, random data (seed %i): same threads, same order, for every agent and status", async (seed) => {
    const store = new SqliteStore(":memory:");
    const { users } = await populate(store, seed);
    let compared = 0;
    for (const u of [...users, "999", "12 ", "", "%", "1' or '1'='1"]) {
      for (const status of [undefined, ...STATUSES]) {
        const got = await store.listThreadsFor(u, status);
        expect(got.map((t) => t.id)).toEqual(legacyList(rawOf(store), u, status));
        for (const t of got) expect(await store.getThread(t.id)).toEqual(t); // whole rows, not just ids
        compared += got.length;
      }
    }
    expect(compared).toBeGreaterThan(300);
    expect((await store.listThreadsFor("1")).length).toBe(100); // the cap is exercised
    store.close();
  });

  it.each([4, 5])("MemoryStore, random data (seed %i): same threads, same order", async (seed) => {
    const store = new MemoryStore();
    const { users, threads } = await populate(store, seed);
    const all = [...threads.values()];
    for (const u of [...users, "999", ""]) {
      for (const status of [undefined, ...STATUSES]) {
        expect((await store.listThreadsFor(u, status)).map((t) => t.id)).toEqual(legacyMemoryList(all, u, status));
      }
    }
    expect((await store.listThreadsFor("1")).length).toBe(100);
  });

  it("MemoryStore and SqliteStore agree with each other on the same history", async () => {
    const mem = new MemoryStore();
    const sql = new SqliteStore(":memory:");
    const a = await populate(mem, 7);
    await populate(sql, 7);
    for (const u of a.users) {
      for (const status of [undefined, ...STATUSES]) {
        const goals = async (s: Store) => (await s.listThreadsFor(u, status)).map((t) => `${t.goal}|${t.status}|${t.participants.join(",")}`);
        expect(await goals(sql)).toEqual(await goals(mem));
      }
    }
    sql.close();
  });

  it("odd participant lists behave as before: repeats count once, membership is exact", async () => {
    const store = new SqliteStore(":memory:");
    await store.insertAgent({ x_user_id: "1", x_handle: "a", agent_card_url: null, display_name: null, owner_opt_in: true, opted_in_at: null, api_key_hash: "h" });
    const dup = await store.insertThread({ goal: "dup", proposer_x_user_id: "1", participants: ["1", "2", "2", "1"], accepted_by: ["1"], status: "proposed" });
    const none = await store.insertThread({ goal: "none", proposer_x_user_id: "1", participants: [], accepted_by: [], status: "proposed" });
    expect((await store.listThreadsFor("2")).map((t) => t.id)).toEqual([dup.id]);
    expect((await store.listThreadsFor("1")).map((t) => t.id)).toEqual([dup.id]);
    expect((await store.getThread(dup.id))!.participants).toEqual(["1", "2", "2", "1"]); // the stored list is untouched
    expect((await store.getThread(none.id))!.participants).toEqual([]);
    for (const u of ["1", "2", "12", "21", ""]) expect((await store.listThreadsFor(u)).map((t) => t.id)).toEqual(legacyList(rawOf(store), u));
    const mem = new MemoryStore();
    await mem.insertAgent({ x_user_id: "1", x_handle: "a", agent_card_url: null, display_name: null, owner_opt_in: true, opted_in_at: null, api_key_hash: "h" });
    const mdup = await mem.insertThread({ goal: "dup", proposer_x_user_id: "1", participants: ["1", "2", "2", "1"], accepted_by: ["1"], status: "proposed" });
    expect((await mem.listThreadsFor("2")).map((t) => t.id)).toEqual([mdup.id]);
    store.close();
  });
});

describe("SqliteStore: the participants table", () => {
  it("answers from the index: no scan of mesh_threads in the query plan", async () => {
    const store = new SqliteStore(":memory:");
    await populate(store, 9);
    const db = rawOf(store);
    const from = "from mesh_thread_participants p cross join mesh_threads t on t.id = p.thread_id where p.x_user_id = ?";
    for (const sql of [`select t.* ${from} order by t.updated_at desc, t.rowid desc limit 100`, `select t.* ${from} and t.status = ? order by t.updated_at desc, t.rowid desc limit 100`]) {
      const plan = db.prepare(`explain query plan ${sql}`).all(...(sql.includes("status") ? ["1", "active"] : ["1"])).map((r) => String(r.detail));
      expect(plan.some((d) => /^SEARCH p USING PRIMARY KEY \(x_user_id=\?\)/.test(d))).toBe(true);
      expect(plan.some((d) => /^SEARCH t USING INDEX .*\(id=\?\)/.test(d))).toBe(true);
      expect(plan.filter((d) => d.startsWith("SCAN"))).toEqual([]);
    }
    // The previous query, for contrast, scans every thread.
    const old = db.prepare("explain query plan select * from mesh_threads where exists (select 1 from json_each(mesh_threads.participants) where value = ?) order by updated_at desc, rowid desc limit 100").all("1").map((r) => String(r.detail));
    expect(old.some((d) => d.startsWith("SCAN mesh_threads"))).toBe(true);
    store.close();
  });

  it("holds one row per distinct participant, written with the thread and removed with it", async () => {
    const store = new SqliteStore(":memory:");
    await store.insertAgent({ x_user_id: "1", x_handle: "a", agent_card_url: null, display_name: null, owner_opt_in: true, opted_in_at: null, api_key_hash: "h" });
    const t = await store.insertThread({ goal: "g", proposer_x_user_id: "1", participants: ["1", "2", "3", "2"], accepted_by: ["1"], status: "proposed" });
    const db = rawOf(store);
    const rows = () => db.prepare("select x_user_id, thread_id from mesh_thread_participants order by x_user_id").all().map((r) => `${String(r.x_user_id)}:${String(r.thread_id)}`);
    expect(rows()).toEqual([`1:${t.id}`, `2:${t.id}`, `3:${t.id}`]);
    // A thread that fails its own constraints leaves no participant rows behind.
    await expect(store.insertThread({ goal: "", proposer_x_user_id: "1", participants: ["1", "9"], accepted_by: [], status: "proposed" })).rejects.toThrow();
    await expect(store.insertThread({ goal: "g", proposer_x_user_id: "ghost", participants: ["1", "9"], accepted_by: [], status: "proposed" })).rejects.toThrow();
    expect(rows()).toHaveLength(3);
    // Status changes do not touch them.
    await store.updateThread(t.id, { status: "active", accepted_by: ["1", "2", "3"] }, t.updated_at);
    expect(rows()).toHaveLength(3);
    db.exec("delete from mesh_agents where x_user_id = '1'"); // cascades to threads, and on to participant rows
    expect(rows()).toEqual([]);
    store.close();
  });
});

describe("SqliteStore: participants backfill on a database made by the previous release", () => {
  function legacyFile() {
    const file = tmpFile();
    const old = new LegacyDb(file);
    for (const [id, handle] of [["1", "alice"], ["2", "bob"], ["3", "carol"], ["4", "dave"]] as const) old.agent(id, handle);
    const ids = {
      ab: old.thread("1", ["1", "2"], "alice and bob", "active"),
      abc: old.thread("1", ["1", "2", "3"], "all three", "proposed"),
      cb: old.thread("3", ["3", "2"], "carol and bob", "completed"),
      d: old.thread("4", ["4"], "dave alone", "proposed"),
    };
    old.message(ids.ab, "1", "hello");
    old.message(ids.ab, "2", "hi");
    // Shapes the previous release could not write itself, but the migration must not choke on.
    old.db.prepare("insert into mesh_threads (id, goal, proposer_x_user_id, participants, accepted_by, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)").run("odd-1", "odd", "4", '["4","4",7,null,{"x":"2"},["3"]]', "[]", "proposed", "2026-11-17T01:00:00.000Z", "2026-11-17T01:00:00.000Z");
    old.db.prepare("insert into mesh_threads (id, goal, proposer_x_user_id, participants, accepted_by, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)").run("odd-2", "odd", "4", "[]", "[]", "proposed", "2026-11-17T01:00:01.000Z", "2026-11-17T01:00:01.000Z");
    old.db.prepare("insert into mesh_threads (id, goal, proposer_x_user_id, participants, accepted_by, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)").run("odd-3", "odd", "4", '{"4":"2"}', "[]", "proposed", "2026-11-17T01:00:02.000Z", "2026-11-17T01:00:02.000Z");
    const expected = new Map<string, string[]>();
    for (const u of ["1", "2", "3", "4", "7", "x", "99"]) expected.set(u, legacyList(old.db, u));
    const before = old.dump();
    old.close();
    return { file, ids, expected, before };
  }
  const count = (file: string) => {
    const db = new DatabaseSync(file);
    try {
      return Number(db.prepare("select count(*) as n from mesh_thread_participants").get()!.n);
    } finally {
      db.close();
    }
  };

  it("lists the same threads in the same order as before the upgrade, and changes no existing row", async () => {
    const { file, ids, expected, before } = legacyFile();
    const store = new SqliteStore(file);
    for (const [u, want] of expected) {
      expect((await store.listThreadsFor(u)).map((t) => t.id)).toEqual(want);
      for (const status of STATUSES) expect((await store.listThreadsFor(u, status)).map((t) => t.id)).toEqual(legacyList(rawOf(store), u, status));
    }
    // "odd-3" stores an object, not an array: json_each walks its values, so "2" was a member before and still is.
    expect((await store.listThreadsFor("2")).map((t) => t.id)).toEqual(["odd-3", ids.cb, ids.abc, ids.ab]);
    expect((await store.listMessages(ids.ab, 10)).length).toBe(2);
    store.close();
    expect(dumpFile(file)).toEqual(before);
    expect(logged().filter((l) => l.includes("backfill"))).toHaveLength(1);
  });

  it("is idempotent: a second and third start add nothing and log nothing", async () => {
    const { file, before } = legacyFile();
    new SqliteStore(file).close();
    const n = count(file);
    expect(n).toBeGreaterThan(0);
    errors.mockClear();
    new SqliteStore(file).close();
    new SqliteStore(file).close();
    expect(count(file)).toBe(n);
    expect(logged()).toEqual([]);
    expect(dumpFile(file)).toEqual(before);
  });

  it("two processes starting at once on the old file both come up, with one set of rows", async () => {
    const { file, expected } = legacyFile();
    const a = new SqliteStore(file);
    const b = new SqliteStore(file);
    for (const [u, want] of expected) {
      expect((await a.listThreadsFor(u)).map((t) => t.id)).toEqual(want);
      expect((await b.listThreadsFor(u)).map((t) => t.id)).toEqual(want);
    }
    a.close();
    b.close();
    const single = legacyFile();
    new SqliteStore(single.file).close();
    expect(count(file)).toBe(count(single.file));
  });

  it("survives a roll-back: threads the previous release writes after the upgrade are picked up on the next start", async () => {
    const { file } = legacyFile();
    new SqliteStore(file).close();
    // The previous release opens the upgraded file (its DDL is all `if not exists`) and writes a thread its own way.
    const old = new LegacyDb(file);
    const late = old.thread("2", ["2", "4"], "written by the old version");
    expect(legacyList(old.db, "4")).toContain(late); // the old version reads the upgraded file fine
    old.close();
    const store = new SqliteStore(file);
    expect((await store.listThreadsFor("4")).map((t) => t.id)).toEqual(legacyList(rawOf(store), "4"));
    expect((await store.listThreadsFor("4")).map((t) => t.id)).toContain(late);
    // And new threads written by this version are visible to the old query too.
    const fresh = await store.insertThread({ goal: "new", proposer_x_user_id: "1", participants: ["1", "4"], accepted_by: ["1"], status: "proposed" });
    expect(legacyList(rawOf(store), "4")[0]).toBe(fresh.id);
    store.close();
  });

  it("the tools return the same thread list before and after the upgrade", async () => {
    // Build history through the real tools on a legacy-schema file is not possible (the old code is
    // gone), so: build it with this version, strip the new table, and compare list_threads output.
    const file = tmpFile();
    const first = new SqliteStore(file);
    const mesh = new Mesh(first, testConfig());
    const alice = await register(mesh, "1", "alice");
    const bob = await register(mesh, "2", "bob");
    await register(mesh, "3", "carol");
    await call(mesh, alice.ctx, "list_mutual_agents", { follower_ids: ["2", "3"], following_ids: ["2", "3"] });
    for (let i = 0; i < 6; i++) {
      const p = await call(mesh, alice.ctx, "propose_goal", { goal: `goal ${i}`, participant_x_user_ids: i % 2 ? ["2"] : ["2", "3"] });
      if (i % 3 === 0) await call(mesh, bob.ctx, "accept_goal", { thread_id: p.body.thread.thread_id, accept: i !== 3 });
    }
    const listAll = async (m: Mesh) => ({
      alice: (await call(m, alice.ctx, "list_threads")).body.threads,
      bob: (await call(m, bob.ctx, "list_threads")).body.threads,
      bobProposed: (await call(m, bob.ctx, "list_threads", { status: "proposed" })).body.threads,
      bobDeclined: (await call(m, bob.ctx, "list_threads", { status: "declined" })).body.threads,
    });
    const before = await listAll(mesh);
    expect(before.bob).toHaveLength(6);
    first.close();
    const raw = new DatabaseSync(file);
    raw.exec("drop table mesh_thread_participants"); // back to what the previous release had
    raw.close();
    const second = new SqliteStore(file);
    expect(await listAll(new Mesh(second, testConfig()))).toEqual(before);
    second.close();
  });
});
