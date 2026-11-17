import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { testConfig, type MeshConfig } from "../src/config.js";
import { buildMcpServer } from "../src/mcp.js";
import { Mesh, type CallContext } from "../src/mesh.js";
import { MemoryStore } from "../src/store.js";

export function newMesh(over: Partial<MeshConfig> = {}, now?: () => number) {
  return new Mesh(new MemoryStore(), testConfig(over), now);
}

export interface Result {
  isError: boolean;
  body: any;
}

/** Calls one MCP tool as `ctx` through a real MCP client/server pair (in-memory transport). */
export async function call(mesh: Mesh, ctx: CallContext, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const server = buildMcpServer(mesh, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* SDK validation errors are plain text */
    }
    return { isError: Boolean(r.isError), body };
  } finally {
    await client.close();
    await server.close();
  }
}

export async function client(mesh: Mesh, ctx: CallContext) {
  const server = buildMcpServer(mesh, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  return c;
}

export interface TestAgent {
  id: string;
  handle: string;
  key: string;
  ctx: CallContext;
}

export async function register(mesh: Mesh, id: string, handle: string, extra: Record<string, unknown> = {}): Promise<TestAgent> {
  const r = await call(mesh, { ip: `ip-${id}` }, "register_agent", { x_user_id: id, x_handle: handle, owner_opt_in: true, ...extra });
  if (r.isError) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  return { id, handle, key: r.body.api_key, ctx: { apiKey: r.body.api_key, ip: `ip-${id}` } };
}

/** alice (1), bob (2), carol (3) registered; alice has told the mesh that bob and carol are her mutuals. */
export async function trio(mesh: Mesh) {
  const alice = await register(mesh, "1", "alice");
  const bob = await register(mesh, "2", "bob");
  const carol = await register(mesh, "3", "carol");
  await call(mesh, alice.ctx, "list_mutual_agents", { follower_ids: ["2", "3"], following_ids: ["2", "3"] });
  return { alice, bob, carol };
}

/** An active thread between alice and bob. */
export async function activeThread(mesh: Mesh) {
  const t = await trio(mesh);
  const p = await call(mesh, t.alice.ctx, "propose_goal", { goal: "Plan the meetup", participant_x_user_ids: ["2"] });
  const threadId: string = p.body.thread.thread_id;
  await call(mesh, t.bob.ctx, "accept_goal", { thread_id: threadId, accept: true });
  return { ...t, threadId };
}
