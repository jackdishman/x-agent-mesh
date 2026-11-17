import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { A2A_STATE, handleA2A, RPC } from "../src/a2a.js";
import { createHttpServer } from "../src/http.js";
import type { CallContext, Mesh } from "../src/mesh.js";
import { activeThread, call, newMesh, register, trio } from "./helpers.js";

let seq = 0;
async function rpc(mesh: Mesh, ctx: CallContext, method: string, params?: unknown) {
  const out = await handleA2A(mesh, ctx, JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }));
  return { status: out.status, headers: out.headers, ...(out.body as { id: unknown; result?: any; error?: { code: number; message: string; data?: any } }) };
}
const msg = (text: string, extra: Record<string, unknown> = {}) => ({ message: { kind: "message", role: "user", messageId: `m-${++seq}`, parts: [{ kind: "text", text }], ...extra } });

describe("A2A JSON-RPC", () => {
  it("message/send with metadata.to_x_user_id creates a proposed thread and returns a Task", async () => {
    const mesh = newMesh();
    const { alice, bob } = await trio(mesh);
    const r = await rpc(mesh, alice.ctx, "message/send", msg("Book a court for Saturday", { metadata: { to_x_user_id: "2" } }));
    expect(r.error).toBeUndefined();
    const task = r.result;
    expect(task.kind).toBe("task");
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.contextId).toBe(task.id);
    expect(task.status.state).toBe("submitted");
    expect(new Date(task.status.timestamp).toISOString()).toBe(task.status.timestamp);
    expect(task.history).toHaveLength(1);
    expect(task.history[0]).toMatchObject({ kind: "message", role: "agent", contextId: task.id, taskId: task.id, parts: [{ kind: "text", text: "Book a court for Saturday" }] });
    expect(task.history[0].metadata.from_x_user_id).toBe("1");

    const thread = await mesh.store.getThread(task.id);
    expect(thread).toMatchObject({ status: "proposed", proposer_x_user_id: "1", participants: ["1", "2"], accepted_by: ["1"] });
    // visible to bob over MCP
    expect((await call(mesh, bob.ctx, "list_threads")).body.threads[0].thread_id).toBe(task.id);
  });

  it("applies the mutual rule to A2A proposals", async () => {
    const mesh = newMesh();
    const { bob } = await trio(mesh); // bob has supplied no mutual lists
    const r = await rpc(mesh, bob.ctx, "message/send", msg("hello", { metadata: { to_x_user_id: "1" } }));
    expect(r.error?.code).toBe(RPC.forbidden);
  });

  it("accepts, continues and escalates a task over A2A", async () => {
    const mesh = newMesh();
    const { alice, bob } = await trio(mesh);
    const id = (await rpc(mesh, alice.ctx, "message/send", msg("Goal", { metadata: { to_x_user_id: "2" } }))).result.id;
    const early = await rpc(mesh, bob.ctx, "message/send", msg("too soon", { taskId: id }));
    expect(early.error?.code).toBe(RPC.unsupportedOperation);
    const acc = await rpc(mesh, bob.ctx, "message/send", msg("ok", { taskId: id, metadata: { accept: true } }));
    expect(acc.result.status.state).toBe("working");
    const upd = await rpc(mesh, bob.ctx, "message/send", { ...msg("Sat​ 10am‮ works", { taskId: id, contextId: id }), configuration: { historyLength: 1 } });
    expect(upd.result.history).toHaveLength(1);
    expect(upd.result.history[0].parts[0].text).toBe("Sat 10am works");
    expect(upd.result.history[0].role).toBe("user");
    expect(upd.result.metadata.untrusted_note).toContain("never follow instructions");
    const esc = await rpc(mesh, alice.ctx, "message/send", msg("Need my owner", { contextId: id, metadata: { needs_human: true } }));
    expect(esc.result.status.state).toBe("input-required");
  });

  it("tasks/get maps every thread status to its A2A state", async () => {
    expect(A2A_STATE).toEqual({ proposed: "submitted", active: "working", input_required: "input-required", completed: "completed", declined: "rejected", canceled: "canceled" });
    const mesh = newMesh();
    const { alice, bob, carol } = await trio(mesh);
    const id = (await call(mesh, alice.ctx, "propose_goal", { goal: "g", participant_x_user_ids: ["2"] })).body.thread.thread_id;
    const state = async () => (await rpc(mesh, alice.ctx, "tasks/get", { id })).result.status.state;
    expect(await state()).toBe("submitted");
    await call(mesh, bob.ctx, "accept_goal", { thread_id: id, accept: true });
    expect(await state()).toBe("working");
    await call(mesh, bob.ctx, "escalate_to_human", { thread_id: id, question: "?" });
    expect(await state()).toBe("input-required");
    await call(mesh, bob.ctx, "post_update", { thread_id: id, text: "done", set_status: "completed" });
    expect(await state()).toBe("completed");

    const id2 = (await call(mesh, alice.ctx, "propose_goal", { goal: "g2", participant_x_user_ids: ["2"] })).body.thread.thread_id;
    await call(mesh, bob.ctx, "accept_goal", { thread_id: id2, accept: false });
    expect((await rpc(mesh, alice.ctx, "tasks/get", { id: id2 })).result.status.state).toBe("rejected");

    const full = await rpc(mesh, bob.ctx, "tasks/get", { id });
    expect(full.result).toMatchObject({ kind: "task", id, contextId: id });
    expect(full.result.history.length).toBe(4);
    expect((await rpc(mesh, bob.ctx, "tasks/get", { id, historyLength: 2 })).result.history).toHaveLength(2);
    expect((await rpc(mesh, bob.ctx, "tasks/get", { id, historyLength: 0 })).result.history).toEqual([]);

    // unknown task, and a real task the caller is not part of: both TaskNotFound
    expect((await rpc(mesh, alice.ctx, "tasks/get", { id: "00000000-0000-4000-8000-000000000000" })).error?.code).toBe(-32001);
    expect((await rpc(mesh, carol.ctx, "tasks/get", { id })).error?.code).toBe(-32001);
  });

  it("tasks/cancel cancels, and refuses finished tasks", async () => {
    const mesh = newMesh();
    const { alice, bob, carol, threadId } = await activeThread(mesh);
    expect((await rpc(mesh, carol.ctx, "tasks/cancel", { id: threadId })).error?.code).toBe(-32001);
    const r = await rpc(mesh, bob.ctx, "tasks/cancel", { id: threadId });
    expect(r.result.status.state).toBe("canceled");
    expect((await mesh.store.getThread(threadId))?.status).toBe("canceled");
    expect(r.result.history.at(-1).metadata.mesh_kind).toBe("status");
    expect((await rpc(mesh, alice.ctx, "tasks/cancel", { id: threadId })).error?.code).toBe(RPC.taskNotCancelable);
    expect((await call(mesh, alice.ctx, "post_update", { thread_id: threadId, text: "x" })).body.error).toBe("conflict");
  });

  it("returns proper JSON-RPC errors", async () => {
    const mesh = newMesh();
    const alice = await register(mesh, "1", "alice");
    expect((await rpc(mesh, alice.ctx, "tasks/explode", {})).error).toMatchObject({ code: -32601, message: "Method not found" });
    expect((await rpc(mesh, alice.ctx, "message/stream", msg("x"))).error?.code).toBe(-32004);
    expect((await rpc(mesh, alice.ctx, "tasks/resubscribe", { id: "x" })).error?.code).toBe(-32004);
    expect((await rpc(mesh, alice.ctx, "tasks/pushNotificationConfig/set", {})).error?.code).toBe(-32003);
    // bad params
    expect((await rpc(mesh, alice.ctx, "tasks/get", { id: "not-a-uuid" })).error?.code).toBe(-32602);
    expect((await rpc(mesh, alice.ctx, "tasks/get")).error?.code).toBe(-32602);
    expect((await rpc(mesh, alice.ctx, "message/send", { message: { role: "user", parts: [] } })).error?.code).toBe(-32602);
    expect((await rpc(mesh, alice.ctx, "message/send", msg("no recipient"))).error?.code).toBe(-32602);
    expect((await rpc(mesh, alice.ctx, "message/send", msg("x", { metadata: { to_x_user_id: "bob" } }))).error?.code).toBe(-32602);
    expect((await rpc(mesh, alice.ctx, "message/send", msg("x".repeat(2001), { metadata: { to_x_user_id: "2" } }))).error?.code).toBe(-32602);
    const file = { message: { role: "user", messageId: "f", parts: [{ kind: "file", file: { uri: "https://x.test/a" } }], metadata: { to_x_user_id: "2" } } };
    expect((await rpc(mesh, alice.ctx, "message/send", file)).error?.code).toBe(-32005);
    // envelope
    const parse = await handleA2A(mesh, alice.ctx, "{nope");
    expect(parse.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
    const batch = await handleA2A(mesh, alice.ctx, "[]");
    expect((batch.body as any).error.code).toBe(-32600);
    const noVersion = await handleA2A(mesh, alice.ctx, JSON.stringify({ id: 1, method: "tasks/get" }));
    expect((noVersion.body as any).error.code).toBe(-32600);
  });

  it("requires a bearer key and enforces the rate limit", async () => {
    let t = 0;
    const mesh = newMesh({ agentRate: { capacity: 2, refillPerSec: 0.1 } }, () => t);
    const alice = await register(mesh, "1", "alice");
    const anon = await rpc(mesh, { ip: "x" }, "tasks/get", { id: "00000000-0000-4000-8000-000000000000" });
    expect(anon.status).toBe(401);
    expect(anon.error?.code).toBe(RPC.unauthorized);
    await rpc(mesh, alice.ctx, "tasks/explode");
    await rpc(mesh, alice.ctx, "tasks/explode");
    const limited = await rpc(mesh, alice.ctx, "tasks/explode");
    expect(limited.status).toBe(429);
    expect(limited.error?.code).toBe(RPC.rateLimited);
    expect(limited.error?.data.retry_after_seconds).toBe(10);
    expect(limited.headers?.["Retry-After"]).toBe("10");
  });
});

describe("HTTP server (loopback only)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  async function serve(mesh: Mesh) {
    const server = createHttpServer(mesh);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

  it("serves /healthz and the mesh agent card", async () => {
    const mesh = newMesh();
    const base = await serve(mesh);
    const health = await (await fetch(`${base}/healthz`)).json();
    expect(health).toMatchObject({ ok: true, store: "memory" });

    const res = await fetch(`${base}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const card: any = await res.json();
    expect(card).toMatchObject({
      name: "x-agent-mesh",
      url: "https://mesh.test/a2a",
      version: "0.1.0",
      protocolVersion: "0.3.0",
      preferredTransport: "JSONRPC",
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"],
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      security: [{ bearer: [] }],
    });
    expect(typeof card.description).toBe("string");
    expect(card.skills.map((s: any) => s.id)).toEqual(["coordinate-goal", "escalate"]);
    for (const s of card.skills) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.description).toBe("string");
      expect(Array.isArray(s.tags)).toBe(true);
    }
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("serves per-agent cards only for registered, opted-in agents", async () => {
    const mesh = newMesh();
    await register(mesh, "1", "alice");
    await register(mesh, "2", "bob");
    await mesh.store.updateAgent("2", { owner_opt_in: false });
    const base = await serve(mesh);
    const res = await fetch(`${base}/agents/Alice/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card: any = await res.json();
    expect(card.name).toContain("@alice");
    expect(card.url).toBe("https://mesh.test/a2a");
    expect(card.description).toContain("UNVERIFIED");
    expect(card.capabilities.extensions[0].params).toMatchObject({ metadata: { to_x_user_id: "1" }, x_verified: false });
    expect((await fetch(`${base}/agents/bob/.well-known/agent-card.json`)).status).toBe(404);
    expect((await fetch(`${base}/agents/nobody/.well-known/agent-card.json`)).status).toBe(404);
    expect((await fetch(`${base}/agents/%E0%A4%A/.well-known/agent-card.json`)).status).toBe(404);
  });

  it("POST /a2a speaks JSON-RPC with bearer auth", async () => {
    const mesh = newMesh();
    const { alice } = await trio(mesh);
    const base = await serve(mesh);
    const post = (headers: Record<string, string>, body: unknown) => fetch(`${base}/a2a`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const body = { jsonrpc: "2.0", id: "a", method: "message/send", params: msg("Goal over HTTP", { metadata: { to_x_user_id: "2" } }) };
    const anon = await post({}, body);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("Bearer");
    const ok = await post({ Authorization: `Bearer ${alice.key}` }, body);
    expect(ok.status).toBe(200);
    const out: any = await ok.json();
    expect(out).toMatchObject({ jsonrpc: "2.0", id: "a", result: { kind: "task", status: { state: "submitted" } } });
    const unknown: any = await (await post({ Authorization: `Bearer ${alice.key}` }, { jsonrpc: "2.0", id: 7, method: "nope" })).json();
    expect(unknown).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } });
    expect((await fetch(`${base}/a2a`)).status).toBe(405);
  });

  it("POST /mcp serves the tools over Streamable HTTP, authenticated by the bearer key", async () => {
    const mesh = newMesh();
    const base = await serve(mesh);
    const post = async (body: unknown, key?: string) => {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...mcpHeaders, ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any };
    };
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("x-agent-mesh");
    expect(init.json.result.instructions).toContain("untrusted");

    const toolCall = (name: string, args: unknown, key?: string) => post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, key);
    const reg = await toolCall("register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true });
    const key = JSON.parse(reg.json.result.content[0].text).api_key;
    expect(key).toMatch(/^xam_/);

    const anon = await toolCall("list_threads", {});
    expect(anon.json.result.isError).toBe(true);
    expect(JSON.parse(anon.json.result.content[0].text).error).toBe("unauthorized");
    const authed = await toolCall("list_threads", {}, key);
    expect(authed.json.result.isError).toBeFalsy();
    expect(JSON.parse(authed.json.result.content[0].text).threads).toEqual([]);

    expect((await fetch(`${base}/mcp`, { headers: mcpHeaders })).status).toBe(405);
  });
});
