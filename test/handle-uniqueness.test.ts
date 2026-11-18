// One agent per X handle (compared without case): enforced by the store in the same step as the
// write, backed by a unique index in SQLite, and added to an existing database without ever
// failing start-up or changing a row.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { testConfig } from "../src/config.js";
import { Mesh, MeshError } from "../src/mesh.js";
import { MemoryStore, SqliteStore, StoreError, SupabaseStore, type NewAgent, type Store } from "../src/store.js";
import { call, register } from "./helpers.js";
import { callback, closeServers, fakeX, login, serve, xOAuth } from "./http-helpers.js";
import { dumpFile, LegacyDb, LEGACY_SCHEMA, legacySchemaFromGit } from "./legacy-schema.js";

const tmp = mkdtempSync(join(tmpdir(), "x-agent-mesh-handles-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let files = 0;
const tmpFile = () => join(tmp, `mesh-${++files}.db`);

const newAgent = (id: string, handle: string): NewAgent => ({
  x_user_id: id,
  x_handle: handle,
  agent_card_url: null,
  display_name: null,
  owner_opt_in: true,
  opted_in_at: "2026-11-16T00:00:00.000Z",
  api_key_hash: `hash-${id}`,
});

const indexNames = (path: string) => {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("pragma index_list('mesh_agents')").all().map((r) => String(r.name));
  } finally {
    db.close();
  }
};

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  errors.mockRestore();
  vi.unstubAllGlobals();
  await closeServers();
});
const logged = () => errors.mock.calls.map((c: unknown[]) => c.map(String).join(" "));

const STORES: [string, () => Store][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["SqliteStore (:memory:)", () => new SqliteStore(":memory:")],
  ["SqliteStore (file)", () => new SqliteStore(tmpFile())],
];

describe.each(STORES)("handle uniqueness: %s", (_name, make) => {
  it("refuses a second agent with the same handle in any case, with a typed error", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "Alice_A"));
    for (const handle of ["Alice_A", "alice_a", "ALICE_A"]) {
      const err = await s.insertAgent(newAgent("2", handle)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("handle_taken");
    }
    expect(await s.getAgentByXUserId("2")).toBeNull();
    // `_` is a character, not a wildcard: a different handle is free.
    expect((await s.insertAgent(newAgent("3", "AliceXA"))).x_handle).toBe("AliceXA");
  });

  it("refuses a second agent with the same x_user_id, with a typed error", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    const err = await s.insertAgent(newAgent("1", "other")).catch((e: unknown) => e);
    expect((err as StoreError).code).toBe("x_user_id_taken");
    expect((await s.getAgentByXUserId("1"))!.x_handle).toBe("alice");
    expect(await s.getAgentByHandle("other")).toBeNull();
  });

  it("refuses renaming an agent onto another agent's handle, and allows everything else", async () => {
    const s = make();
    await s.insertAgent(newAgent("1", "alice"));
    await s.insertAgent(newAgent("2", "bob"));
    const err = await s.updateAgent("2", { x_handle: "ALICE", display_name: "sneaky" }).catch((e: unknown) => e);
    expect((err as StoreError).code).toBe("handle_taken");
    expect(await s.getAgentByXUserId("2")).toMatchObject({ x_handle: "bob", display_name: null }); // the whole patch was refused
    // Changing the case of one's own handle, keeping it, or taking a free one is fine.
    expect((await s.updateAgent("1", { x_handle: "Alice" })).x_handle).toBe("Alice");
    expect((await s.updateAgent("1", { x_handle: "Alice" })).x_handle).toBe("Alice");
    expect((await s.updateAgent("2", { x_handle: "robert" })).x_handle).toBe("robert");
    // The old handle is free again.
    expect((await s.insertAgent(newAgent("3", "bob"))).x_handle).toBe("bob");
    // A patch without a handle never trips the check.
    expect((await s.updateAgent("3", { display_name: "Bob" })).display_name).toBe("Bob");
  });

  it("of many concurrent inserts of one handle, exactly one wins", async () => {
    const s = make();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => s.insertAgent(newAgent(String(100 + i), i % 2 ? "Racer" : "racer"))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as StoreError).code).toBe("handle_taken");
    expect(await s.getAgentByHandle("RACER")).not.toBeNull();
  });

  it("two registrations racing for one handle: one key is issued, the other gets a clean conflict", async () => {
    const mesh = new Mesh(make(), testConfig());
    const results = await Promise.allSettled([
      mesh.register({ ip: "a" }, { x_user_id: "1", x_handle: "alice" }),
      mesh.register({ ip: "b" }, { x_user_id: "2", x_handle: "ALICE" }),
      mesh.register({ ip: "c" }, { x_user_id: "3", x_handle: "Alice" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status !== "rejected") continue;
      expect(r.reason).toBeInstanceOf(MeshError);
      expect((r.reason as MeshError).code).toBe("conflict");
      expect((r.reason as MeshError).message).toBe("This x_handle is already registered to a different x_user_id.");
    }
    expect(logged()).toEqual([]); // an expected conflict is not a database error
  });

  it("two first registrations racing for one x_user_id: one wins, the other is told it is registered", async () => {
    const mesh = new Mesh(make(), testConfig());
    const results = await Promise.allSettled([
      mesh.register({ ip: "a" }, { x_user_id: "1", x_handle: "alice" }),
      mesh.register({ ip: "b" }, { x_user_id: "1", x_handle: "alice" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as MeshError).code).toBe("forbidden");
    expect((lost.reason as MeshError).message).toMatch(/^This x_user_id is already registered\./);
  });

  it("a check that read stale data still cannot create a duplicate (the store has the last word)", async () => {
    const store = make();
    const mesh = new Mesh(store, testConfig());
    await register(mesh, "1", "alice");
    // What a racing request sees: the handle looked free when it checked.
    store.getAgentByHandle = async () => null;
    const r = await call(mesh, { ip: "b" }, "register_agent", { x_user_id: "9", x_handle: "Alice", owner_opt_in: true });
    expect(r.isError).toBe(true);
    expect(r.body).toEqual({ error: "conflict", message: "This x_handle is already registered to a different x_user_id." });
    expect(await store.getAgentByXUserId("9")).toBeNull();
  });

  it("rotating a key, or re-registering under a new free handle, still works", async () => {
    const mesh = new Mesh(make(), testConfig());
    const alice = await register(mesh, "1", "alice");
    await register(mesh, "2", "bob");
    const same = await call(mesh, alice.ctx, "register_agent", { x_user_id: "1", x_handle: "ALICE", owner_opt_in: true });
    expect(same.isError).toBe(false);
    const ctx = { ip: "ip-1", apiKey: same.body.api_key as string };
    const renamed = await call(mesh, ctx, "register_agent", { x_user_id: "1", x_handle: "alice_new", owner_opt_in: true });
    expect(renamed.body).toMatchObject({ rotated: true, x_handle: "alice_new" });
    const taken = await call(mesh, { ip: "ip-1", apiKey: renamed.body.api_key as string }, "register_agent", { x_user_id: "1", x_handle: "BOB", owner_opt_in: true });
    expect(taken.body.error).toBe("conflict");
    // The refused rename did not rotate the key.
    expect((await call(mesh, { ip: "ip-1", apiKey: renamed.body.api_key as string }, "list_threads")).isError).toBe(false);
  });
});

describe("Sign in with X: a rename onto a handle taken in the meantime", () => {
  it("answers the usual 409 page instead of failing, and verifies nobody", async () => {
    const store = new MemoryStore();
    const mesh = new Mesh(store, testConfig({ xOAuth }));
    const x = fakeX();
    const base = await serve(mesh);
    const r = await call(mesh, { ip: "a" }, "register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true });
    await register(mesh, "2", "bob");
    // X says user 1 is now called @bob; the server's own check is made to miss the holder, as it
    // would if bob had registered between that check and the write.
    x.me = { data: { id: "1", name: "Alice", username: "Bob" } };
    const real = store.getAgentByHandle.bind(store);
    store.getAgentByHandle = async (h) => (h.toLowerCase() === "bob" ? null : real(h));
    const l = await login((r.body.verify_url as string).replace("https://mesh.test", base));
    const c = await callback(base, { state: l.state, code: "code" }, l.cookie);
    expect(c.status).toBe(409);
    expect(c.html).toContain("handle already registered");
    expect(await store.getAgentByXUserId("1")).toMatchObject({ x_handle: "alice", x_verified: false });
    expect(await store.getAgentByXUserId("2")).toMatchObject({ x_handle: "bob" });
  });
});

describe("SqliteStore: the unique index on lower(x_handle)", () => {
  it("exists on a fresh database and refuses a duplicate even from raw SQL", async () => {
    const file = tmpFile();
    const s = new SqliteStore(file);
    expect(s.handlesUnique).toBe(true);
    await s.insertAgent(newAgent("1", "alice"));
    s.close();
    expect(indexNames(file)).toContain("mesh_agents_handle_uniq");
    const raw = new DatabaseSync(file);
    expect(() =>
      raw.exec("insert into mesh_agents (id, x_user_id, x_handle, created_at, updated_at) values ('x', '2', 'ALICE', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"),
    ).toThrow(/UNIQUE constraint failed/);
    raw.close();
  });

  it("two connections to one file cannot both register a handle", async () => {
    const file = tmpFile();
    const a = new SqliteStore(file);
    const b = new SqliteStore(file);
    const results = await Promise.allSettled([a.insertAgent(newAgent("1", "alice")), b.insertAgent(newAgent("2", "Alice"))]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as StoreError).code).toBe("handle_taken");
    a.close();
    b.close();
  });

  it("the copy of the previous release's schema used by these tests matches git history", () => {
    const fromGit = legacySchemaFromGit();
    if (fromGit === null) return; // no git, or a shallow checkout without that commit: nothing to compare against
    expect(LEGACY_SCHEMA).toBe(fromGit);
  });

  it("is added to a database made by the previous release, changing no row", async () => {
    const file = tmpFile();
    const old = new LegacyDb(file);
    old.agent("1", "alice", { verified: true });
    old.agent("2", "Bob");
    const t = old.thread("1", ["1", "2"], "Plan the meetup", "active");
    old.message(t, "1", "hello");
    const before = old.dump();
    old.close();
    expect(indexNames(file)).not.toContain("mesh_agents_handle_uniq");

    const s = new SqliteStore(file);
    expect(s.handlesUnique).toBe(true);
    expect(await s.getAgentByHandle("BOB")).toMatchObject({ x_user_id: "2", x_handle: "Bob" });
    expect(await s.getAgentByKeyHash("hash-1")).toMatchObject({ x_user_id: "1", x_verified: true });
    expect(((await s.insertAgent(newAgent("3", "ALICE")).catch((e: unknown) => e)) as StoreError).code).toBe("handle_taken");
    s.close();
    expect(indexNames(file)).toEqual(expect.arrayContaining(["mesh_agents_handle_uniq", "mesh_agents_handle_idx", "mesh_agents_api_key_hash_idx"]));
    expect(dumpFile(file)).toEqual(before);
    expect(logged()).toEqual([]);

    // Opening it again is a no-op.
    const again = new SqliteStore(file);
    expect(again.handlesUnique).toBe(true);
    again.close();
    expect(dumpFile(file)).toEqual(before);
  });

  it("when the old database already holds duplicate handles: starts anyway, warns, deletes nothing, and still refuses new duplicates", async () => {
    const file = tmpFile();
    const old = new LegacyDb(file);
    old.agent("1", "alice");
    old.agent("2", "ALICE"); // the race the previous release allowed
    old.agent("3", "carol");
    const t = old.thread("2", ["2", "3"], "g");
    old.message(t, "2", "hi");
    const before = old.dump();
    old.close();

    const s = new SqliteStore(file); // must not throw
    expect(s.handlesUnique).toBe(false);
    const warnings = logged();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/WARNING: handles registered more than once: @alice \(2 agents\)/);
    expect(warnings[0]).toContain("NOT created");
    expect(warnings[0]).not.toContain("hash-");

    // Everything is still there and still works.
    expect(await s.getAgentByXUserId("1")).toMatchObject({ x_handle: "alice" });
    expect(await s.getAgentByXUserId("2")).toMatchObject({ x_handle: "ALICE" });
    expect((await s.getAgentByHandle("alice"))!.x_user_id).toBe("1"); // the first registered, as before
    expect(await s.getAgentByKeyHash("hash-2")).toMatchObject({ x_user_id: "2" });
    expect((await s.listMessages(t, 10)).length).toBe(1);
    // The existing duplicates can still be updated (key rotation, verification)...
    expect((await s.updateAgent("2", { api_key_hash: "rotated" })).api_key_hash).toBe("rotated");
    // ...but no new duplicate can be made, with or without the index.
    expect(((await s.insertAgent(newAgent("4", "Carol")).catch((e: unknown) => e)) as StoreError).code).toBe("handle_taken");
    expect(((await s.insertAgent(newAgent("4", "Alice")).catch((e: unknown) => e)) as StoreError).code).toBe("handle_taken");
    expect(((await s.updateAgent("3", { x_handle: "alice" }).catch((e: unknown) => e)) as StoreError).code).toBe("handle_taken");
    expect((await s.insertAgent(newAgent("5", "dave"))).x_handle).toBe("dave");
    s.close();
    expect(indexNames(file)).not.toContain("mesh_agents_handle_uniq");
    const after = dumpFile(file);
    expect(after.agents).toHaveLength(4);
    expect(after.threads).toEqual(before.threads);
    expect(after.messages).toEqual(before.messages);

    // The operator renames one of the two by hand; the next start creates the index.
    const raw = new DatabaseSync(file);
    raw.exec("update mesh_agents set x_handle = 'alice_old' where x_user_id = '2'");
    raw.close();
    errors.mockClear();
    const fixed = new SqliteStore(file);
    expect(fixed.handlesUnique).toBe(true);
    expect(logged()).toEqual([]);
    fixed.close();
    expect(indexNames(file)).toContain("mesh_agents_handle_uniq");
  });

  it("the whole mesh works on a database that still has duplicates", async () => {
    const file = tmpFile();
    const old = new LegacyDb(file);
    old.agent("7", "dup");
    old.agent("8", "DUP");
    old.close();
    const store = new SqliteStore(file);
    const mesh = new Mesh(store, testConfig());
    const alice = await register(mesh, "1", "alice");
    await register(mesh, "2", "bob");
    await call(mesh, alice.ctx, "list_mutual_agents", { follower_ids: ["2", "7", "8"], following_ids: ["2", "7", "8"] });
    const p = await call(mesh, alice.ctx, "propose_goal", { goal: "g", participant_x_user_ids: ["2", "8"] });
    expect(p.isError).toBe(false);
    expect((await call(mesh, { ip: "z" }, "register_agent", { x_user_id: "9", x_handle: "dup", owner_opt_in: true })).body.error).toBe("conflict");
    store.close();
  });
});

describe("SupabaseStore: unique violations", () => {
  const failing = (error: { message: string; code?: string; details?: string }) =>
    ({
      from: () => {
        const b: any = new Proxy({}, { get: (_t, prop: string) => (prop === "then" ? (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(ok) : () => b) });
        return b;
      },
    }) as unknown as SupabaseClient;

  it("maps Postgres 23505 on the handle index or the x_user_id constraint to the typed errors", async () => {
    const handle = new SupabaseStore(failing({ code: "23505", message: 'duplicate key value violates unique constraint "mesh_agents_handle_uniq"', details: "Key (lower(x_handle))=(alice) already exists." }));
    expect(((await handle.insertAgent(newAgent("2", "Alice")).catch((e: unknown) => e)) as StoreError).code).toBe("handle_taken");
    expect(((await handle.updateAgent("2", { x_handle: "Alice" }).catch((e: unknown) => e)) as StoreError).code).toBe("handle_taken");
    const id = new SupabaseStore(failing({ code: "23505", message: 'duplicate key value violates unique constraint "mesh_agents_x_user_id_key"', details: "Key (x_user_id)=(1) already exists." }));
    expect(((await id.insertAgent(newAgent("1", "alice")).catch((e: unknown) => e)) as StoreError).code).toBe("x_user_id_taken");
    expect(logged()).toEqual([]);
  });

  it("keeps every other database error generic", async () => {
    const other = new SupabaseStore(failing({ code: "23505", message: 'duplicate key value violates unique constraint "mesh_messages_pkey"' }));
    await expect(other.insertAgent(newAgent("1", "alice"))).rejects.toThrow(/^The mesh database is unavailable/);
    const down = new SupabaseStore(failing({ message: "connection refused" }));
    await expect(down.insertAgent(newAgent("1", "alice"))).rejects.toThrow(/^The mesh database is unavailable/);
    expect(logged()).toHaveLength(2);
  });
});
