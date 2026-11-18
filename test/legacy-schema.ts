// The SQLite schema exactly as the previous release created it (src/sqlite-store.ts at commit
// 1a36bae; unchanged since the SQLite store was introduced in ee04028). The live /data/mesh.db was
// made by this DDL, so the migration tests start from a file built with it.
// test/migrations.test.ts checks this copy against git history when git is available.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const LEGACY_COMMIT = "1a36bae";

export const LEGACY_SCHEMA = `
create table if not exists mesh_agents (
  id text primary key,
  x_user_id text not null unique,
  x_handle text not null,
  agent_card_url text,
  display_name text,
  owner_opt_in integer not null default 0 check (owner_opt_in in (0, 1)),
  opted_in_at text,
  x_verified integer not null default 0 check (x_verified in (0, 1)),
  api_key_hash text,
  created_at text not null,
  updated_at text not null
);
create index if not exists mesh_agents_handle_idx on mesh_agents (lower(x_handle));
create index if not exists mesh_agents_api_key_hash_idx on mesh_agents (api_key_hash);
create table if not exists mesh_threads (
  id text primary key,
  goal text not null check (length(goal) between 1 and 2000),
  proposer_x_user_id text not null references mesh_agents(x_user_id) on delete cascade,
  participants text not null check (json_valid(participants)),
  accepted_by text not null default '[]' check (json_valid(accepted_by)),
  status text not null default 'proposed' check (status in ('proposed','active','input_required','completed','declined','canceled')),
  created_at text not null,
  updated_at text not null
);
create index if not exists mesh_threads_updated_idx on mesh_threads (updated_at);
create table if not exists mesh_messages (
  id text primary key,
  thread_id text not null references mesh_threads(id) on delete cascade,
  from_x_user_id text not null,
  kind text not null default 'update' check (kind in ('proposal','accept','decline','update','escalation','payment_draft','status')),
  message text not null check (json_valid(message)),
  needs_human integer not null default 0 check (needs_human in (0, 1)),
  created_at text not null
);
create index if not exists mesh_messages_thread_idx on mesh_messages (thread_id, created_at);
`;

/** The schema literal in the previous release's source, or null when git or the commit is not available here. */
export function legacySchemaFromGit(): string | null {
  try {
    const source = execFileSync("git", ["show", `${LEGACY_COMMIT}:src/sqlite-store.ts`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /const SCHEMA = `([^`]*)`;/.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * A database file as the previous release left it: same pragmas, same DDL, and rows written with
 * the previous release's INSERT statements (explicit column lists).
 */
export class LegacyDb {
  readonly db: DatabaseSync;
  private clock = Date.parse("2026-11-17T00:00:00.000Z");

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = WAL; pragma foreign_keys = ON; pragma busy_timeout = 5000;");
    this.db.exec(LEGACY_SCHEMA);
  }

  private stamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  agent(xUserId: string, handle: string, over: { verified?: boolean; optIn?: boolean } = {}): void {
    const at = this.stamp();
    this.db
      .prepare(
        `insert into mesh_agents (id, x_user_id, x_handle, agent_card_url, display_name, owner_opt_in, opted_in_at, api_key_hash, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), xUserId, handle, null, `Owner of ${handle}`, over.optIn === false ? 0 : 1, at, `hash-${xUserId}`, at, at);
    if (over.verified) this.db.prepare("update mesh_agents set x_verified = 1 where x_user_id = ?").run(xUserId);
  }

  thread(proposer: string, participants: string[], goal: string, status = "proposed"): string {
    const id = randomUUID();
    const at = this.stamp();
    this.db
      .prepare(
        `insert into mesh_threads (id, goal, proposer_x_user_id, participants, accepted_by, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, goal, proposer, JSON.stringify(participants), JSON.stringify([proposer]), status, at, at);
    return id;
  }

  message(threadId: string, from: string, text: string, kind = "update"): string {
    const id = randomUUID();
    const body = { kind: "message", role: "agent", parts: [{ kind: "text", text }], messageId: randomUUID(), contextId: threadId, taskId: threadId, metadata: { from_x_user_id: from } };
    this.db
      .prepare("insert into mesh_messages (id, thread_id, from_x_user_id, kind, message, needs_human, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(id, threadId, from, kind, JSON.stringify(body), 0, this.stamp());
    return id;
  }

  /** Every row of every legacy table, for "nothing was changed or lost" assertions. */
  dump(): Record<string, unknown[]> {
    return dumpTables(this.db);
  }

  close(): void {
    this.db.close();
  }
}

/** The legacy tables' rows, restricted to the legacy columns, in a stable order. */
export function dumpTables(db: DatabaseSync): Record<string, unknown[]> {
  return {
    agents: db.prepare("select id, x_user_id, x_handle, agent_card_url, display_name, owner_opt_in, opted_in_at, x_verified, api_key_hash, created_at, updated_at from mesh_agents order by id").all(),
    threads: db.prepare("select id, goal, proposer_x_user_id, participants, accepted_by, status, created_at, updated_at from mesh_threads order by id").all(),
    messages: db.prepare("select id, thread_id, from_x_user_id, kind, message, needs_human, created_at from mesh_messages order by id").all(),
  };
}

/** Opens `path` read-only-ish (a plain second connection) and dumps the legacy tables. */
export function dumpFile(path: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path);
  try {
    return dumpTables(db);
  } finally {
    db.close();
  }
}
