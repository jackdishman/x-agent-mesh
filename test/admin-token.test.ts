import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import { call, newMesh } from "./helpers.js";

const TOKEN = "test-invite-token";
const args = (id = "1") => ({ x_user_id: id, x_handle: `u${id}`, owner_opt_in: true });

describe("registration gate (MESH_ADMIN_TOKEN)", () => {
  it("is open when no token is configured, and ignores a supplied one", async () => {
    const mesh = newMesh();
    expect((await call(mesh, { ip: "a" }, "register_agent", args("1"))).isError).toBe(false);
    expect((await call(mesh, { ip: "a" }, "register_agent", { ...args("2"), admin_token: "anything" })).isError).toBe(false);
  });

  it("rejects registration without a token", async () => {
    const mesh = newMesh({ adminToken: TOKEN });
    const r = await call(mesh, { ip: "a" }, "register_agent", args());
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe("forbidden");
    expect(r.body.message).toContain("invite-only");
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    expect(await mesh.store.getAgentByXUserId("1")).toBeNull();
  });

  it("rejects a wrong token of any length (argument or header)", async () => {
    const mesh = newMesh({ adminToken: TOKEN });
    for (const wrong of ["x", TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase(), "y".repeat(TOKEN.length)]) {
      const byArg = await call(mesh, { ip: "a" }, "register_agent", { ...args(), admin_token: wrong });
      expect(byArg.body.error, wrong).toBe("forbidden");
      expect(byArg.body.message).toContain("Invalid");
      const byHeader = await call(mesh, { ip: "a", adminToken: wrong }, "register_agent", args());
      expect(byHeader.body.error, wrong).toBe("forbidden");
    }
    expect(await mesh.store.getAgentByXUserId("1")).toBeNull();
  });

  it("accepts the correct token as the admin_token argument", async () => {
    const mesh = newMesh({ adminToken: TOKEN });
    const r = await call(mesh, { ip: "a" }, "register_agent", { ...args(), admin_token: TOKEN });
    expect(r.isError).toBe(false);
    expect(r.body.api_key).toMatch(/^xam_/);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    expect((await call(mesh, { ip: "a", apiKey: r.body.api_key }, "list_threads")).isError).toBe(false);
  });

  it("accepts the correct token from the call context (header / stdio env)", async () => {
    const mesh = newMesh({ adminToken: TOKEN });
    expect((await call(mesh, { ip: "a", adminToken: TOKEN }, "register_agent", args())).isError).toBe(false);
    // Either source is enough, even if the other is wrong.
    expect((await call(mesh, { ip: "a", adminToken: "wrong" }, "register_agent", { ...args("2"), admin_token: TOKEN })).isError).toBe(false);
  });

  it("also gates key rotation (re-registration)", async () => {
    const mesh = newMesh({ adminToken: TOKEN });
    const first = await call(mesh, { ip: "a" }, "register_agent", { ...args(), admin_token: TOKEN });
    const ctx = { ip: "a", apiKey: first.body.api_key as string };
    expect((await call(mesh, ctx, "register_agent", args())).body.error).toBe("forbidden");
    expect((await call(mesh, ctx, "list_threads")).isError).toBe(false); // key not rotated
    expect((await call(mesh, ctx, "register_agent", { ...args(), admin_token: TOKEN })).body.rotated).toBe(true);
  });

  it("counts failed attempts against the per-IP registration limit", async () => {
    const mesh = newMesh({ adminToken: TOKEN, ipRate: { capacity: 2, refillPerSec: 0.001 } });
    const bad = () => call(mesh, { ip: "9.9.9.9" }, "register_agent", { ...args(), admin_token: "wrong" });
    expect((await bad()).body.error).toBe("forbidden");
    expect((await bad()).body.error).toBe("forbidden");
    // Bucket is empty: even the correct token is now rate limited from this address.
    const r = await call(mesh, { ip: "9.9.9.9" }, "register_agent", { ...args(), admin_token: TOKEN });
    expect(r.body.error).toBe("rate_limited");
    expect((await call(mesh, { ip: "8.8.8.8" }, "register_agent", { ...args(), admin_token: TOKEN })).isError).toBe(false);
  });
});

describe("registration gate over HTTP", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("POST /mcp takes the token from X-Mesh-Admin-Token or the admin_token argument; A2A cannot register", async () => {
    const mesh = newMesh({ adminToken: TOKEN });
    const server = createHttpServer(mesh);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const reg = async (id: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: { ...args(id), ...extra } } }),
      });
      const json = (await res.json()) as any;
      return { isError: Boolean(json.result.isError), body: JSON.parse(json.result.content[0].text) };
    };

    expect((await reg("1", {})).body.error).toBe("forbidden");
    expect((await reg("1", { "X-Mesh-Admin-Token": "wrong" })).body.error).toBe("forbidden");
    expect((await reg("1", { "X-Mesh-Admin-Token": TOKEN })).isError).toBe(false);
    expect((await reg("2", {}, { admin_token: TOKEN })).isError).toBe(false);

    const health = (await (await fetch(`${base}/healthz`)).json()) as any;
    expect(health.registration).toBe("invite_only");
    expect(JSON.stringify(health)).not.toContain(TOKEN);

    // A2A has no registration path: without an agent key every call is unauthorized, token or not.
    const a2a = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mesh-Admin-Token": TOKEN },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hi" }], metadata: { to_x_user_id: "1" } } } }),
    });
    expect(a2a.status).toBe(401);
  });

  it("MESH_TRUST_PROXY=fly takes the client IP from Fly-Client-IP", async () => {
    const mesh = newMesh({ trustProxy: "fly", ipRate: { capacity: 1, refillPerSec: 0.001 } });
    const server = createHttpServer(mesh);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const reg = async (id: string, ip: string) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Fly-Client-IP": ip, "X-Forwarded-For": "6.6.6.6, 7.7.7.7" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: args(id) } }),
      });
      return JSON.parse(((await res.json()) as any).result.content[0].text);
    };
    expect((await reg("1", "1.1.1.1")).api_key).toMatch(/^xam_/);
    expect((await reg("2", "1.1.1.1")).error).toBe("rate_limited");
    expect((await reg("2", "2.2.2.2")).api_key).toMatch(/^xam_/);
  });
});

describe("loadConfig", () => {
  it("MESH_REQUIRE_ADMIN_TOKEN=1 without MESH_ADMIN_TOKEN refuses to start", () => {
    expect(() => loadConfig({ MESH_REQUIRE_ADMIN_TOKEN: "1" })).toThrow(/MESH_ADMIN_TOKEN is empty/);
    expect(() => loadConfig({ MESH_REQUIRE_ADMIN_TOKEN: "1", MESH_ADMIN_TOKEN: "" })).toThrow(/refusing to start/);
  });

  it("loads the token when set, and leaves registration open when neither variable is set", () => {
    expect(loadConfig({ MESH_REQUIRE_ADMIN_TOKEN: "1", MESH_ADMIN_TOKEN: TOKEN }).adminToken).toBe(TOKEN);
    expect(loadConfig({ MESH_ADMIN_TOKEN: TOKEN }).adminToken).toBe(TOKEN);
    expect(loadConfig({}).adminToken).toBe("");
    expect(loadConfig({ MESH_TRUST_PROXY: "fly" }).trustProxy).toBe("fly");
    expect(loadConfig({ MESH_TRUST_PROXY: "1" }).trustProxy).toBe(true);
  });
});
