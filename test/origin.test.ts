// The Origin check on POST /mcp and /a2a (DNS-rebinding protection): a browser page on another
// origin is refused before anything is read or run; agent clients, which send no Origin header,
// are untouched; the allowlist comes from MESH_ALLOWED_ORIGINS and defaults to the public URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, loadConfig, normalizeOrigin, type MeshConfig } from "../src/config.js";
import { originAllowed } from "../src/http.js";
import { newMesh } from "./helpers.js";
import { a2a, a2aMessage, closeServers, MCP_HEADERS, realFetch, serve, streamRequest, tool } from "./http-helpers.js";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await closeServers();
  expect(errors.mock.calls).toEqual([]); // a refused origin is not a server error and is not logged
  errors.mockRestore();
});

const reg = (id: string, handle = `user_${id}`) => ({ x_user_id: id, x_handle: handle, owner_opt_in: true });
const from = (origin: string) => ({ headers: { Origin: origin } });

async function setup(over: Partial<MeshConfig> = {}) {
  const mesh = newMesh(over); // public URL https://mesh.test, allowed origins: just that
  const base = await serve(mesh);
  return { mesh, base };
}

const FOREIGN = [
  "https://evil.example",
  "http://mesh.test", // same host, other scheme
  "https://mesh.test:8443", // same host, other port
  "https://mesh.test.evil.example",
  "https://evil.example/https://mesh.test",
  "https://mesh.test@evil.example",
  "https://sub.mesh.test",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "null", // sandboxed iframes, file: pages, some redirects
  "chrome-extension://abcdefghijklmnop",
  "https://mesh.test, https://evil.example",
  "https://evil.example, https://mesh.test",
  "not an origin",
  "*",
  "",
  " ",
  "https://",
  "//mesh.test",
  "mesh.test",
];

describe("normalizeOrigin", () => {
  it("gives http(s) origins one spelling and rejects anything that is not a bare origin", () => {
    expect(normalizeOrigin("https://mesh.test")).toBe("https://mesh.test");
    expect(normalizeOrigin("HTTPS://Mesh.Test")).toBe("https://mesh.test");
    expect(normalizeOrigin("https://mesh.test:443")).toBe("https://mesh.test");
    expect(normalizeOrigin("https://mesh.test/")).toBe("https://mesh.test");
    expect(normalizeOrigin(" https://mesh.test ")).toBe("https://mesh.test");
    expect(normalizeOrigin("http://localhost:6274")).toBe("http://localhost:6274");
    expect(normalizeOrigin("http://[::1]:8787")).toBe("http://[::1]:8787");
    expect(normalizeOrigin("null")).toBe("null");
    expect(normalizeOrigin("chrome-extension://AbC/")).toBe("chrome-extension://abc");
    for (const bad of ["", " ", "https://mesh.test/path", "https://mesh.test/?q=1", "https://mesh.test/#f", "https://user:pw@mesh.test", "https://a.test, https://b.test", "https://a.test https://b.test", "mesh.test", "//mesh.test", "*", "https://"]) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
    // A non-http scheme never collapses into "null" (which the URL parser would report as its origin).
    expect(normalizeOrigin("chrome-extension://abc")).not.toBe("null");
    expect(normalizeOrigin("file:///etc/passwd")).not.toBe("null");
  });
});

describe("originAllowed", () => {
  it("lets a request without the header through, whatever the list", () => {
    expect(originAllowed(["https://mesh.test"], undefined)).toBe(true);
    expect(originAllowed([], undefined)).toBe(true);
    expect(originAllowed("*", undefined)).toBe(true);
  });
  it("matches listed origins in any spelling and nothing else", () => {
    const list = ["https://mesh.test", "http://localhost:6274"];
    for (const ok of ["https://mesh.test", "https://MESH.test", "https://mesh.test:443", "http://localhost:6274"]) expect(originAllowed(list, ok), ok).toBe(true);
    for (const bad of FOREIGN) expect(originAllowed(list, bad), bad).toBe(false);
    expect(originAllowed(list, ["https://mesh.test", "https://mesh.test"])).toBe(false); // repeated header
    expect(originAllowed([], "https://mesh.test")).toBe(false);
    expect(originAllowed(["null"], "null")).toBe(true);
    expect(originAllowed(["null"], "chrome-extension://abc")).toBe(false);
    expect(originAllowed("*", "https://evil.example")).toBe(true);
  });
});

describe("MESH_ALLOWED_ORIGINS", () => {
  it("defaults to the origin of the public URL", () => {
    expect(loadConfig({}).allowedOrigins).toEqual(["http://localhost:8787"]);
    expect(loadConfig({ PORT: "9000" }).allowedOrigins).toEqual(["http://localhost:9000"]);
    expect(loadConfig({ MESH_PUBLIC_URL: "https://x-agent-mesh.fly.dev" }).allowedOrigins).toEqual(["https://x-agent-mesh.fly.dev"]);
    expect(loadConfig({ MESH_PUBLIC_URL: "https://Mesh.Example:443/base/", MESH_ALLOWED_ORIGINS: " " }).allowedOrigins).toEqual(["https://mesh.example"]);
  });
  it("takes a comma- or space-separated list, normalised, replacing the default", () => {
    const cfg = loadConfig({ MESH_PUBLIC_URL: "https://mesh.example", MESH_ALLOWED_ORIGINS: "https://app.example.com, HTTP://LocalHost:6274/  https://app.example.com:443,null" });
    expect(cfg.allowedOrigins).toEqual(["https://app.example.com", "http://localhost:6274", "null"]);
    expect(loadConfig({ MESH_ALLOWED_ORIGINS: "*" }).allowedOrigins).toBe("*");
  });
  it("refuses to start on an entry that is not an origin", () => {
    for (const bad of ["https://app.example.com/path", "app.example.com", "https://a.example,*", "https://user:pw@a.example", "https://a.example?x=1"]) {
      expect(() => loadConfig({ MESH_ALLOWED_ORIGINS: bad }), bad).toThrow(/MESH_ALLOWED_ORIGINS: ".*" is not an origin/);
    }
  });
});

describe("agent clients (no Origin header) are unaffected", () => {
  it("the whole journey over /mcp and /a2a works without an Origin header", async () => {
    const { base } = await setup();
    const alice = await tool(base, "register_agent", reg("1", "alice"));
    const bob = await tool(base, "register_agent", reg("2", "bob"));
    expect(alice.isError).toBe(false);
    const ka = alice.body.api_key as string;
    const kb = bob.body.api_key as string;
    expect((await tool(base, "list_mutual_agents", { follower_ids: ["2"], following_ids: ["2"] }, { key: ka })).body.agents).toHaveLength(1);
    const proposed = await a2a(base, "message/send", { ...a2aMessage("Plan the meetup"), metadata: { to_x_user_id: "2" } }, { key: ka });
    expect(proposed.status).toBe(200);
    const taskId = proposed.result.id as string;
    expect((await tool(base, "accept_goal", { thread_id: taskId, accept: true }, { key: kb })).body.thread.status).toBe("active");
    expect((await a2a(base, "tasks/get", { id: taskId }, { key: kb })).result.status.state).toBe("working");
    // The MCP handshake itself (what a client sends first) also carries no Origin.
    const init = await realFetch(`${base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
    expect(init.status).toBe(200);
    expect(((await init.json()) as any).result.serverInfo.name).toBe("x-agent-mesh");
  });
});

describe("a foreign Origin is refused on /mcp and /a2a", () => {
  it("with 403 and a JSON-RPC error, before the key is looked at or anything is run", async () => {
    const { mesh, base } = await setup();
    const key = (await tool(base, "register_agent", reg("1", "alice"))).body.api_key as string;
    const failed = () => ((mesh as any).authFailLimiter.buckets as Map<string, unknown>).size;
    for (const origin of FOREIGN) {
      // Unauthenticated, with a valid key, and with a bad key: the answer is the same.
      for (const k of [undefined, key, "xam_wrong"]) {
        const m = await tool(base, "register_agent", reg("666", "mallory"), { key: k, ...from(origin) });
        expect(m.status, origin).toBe(403);
        expect(m.body).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32011, message: "Origin not allowed", data: expect.stringContaining("MESH_ALLOWED_ORIGINS") } });
        expect(m.headers.get("connection")).toBe("close");
        expect(m.headers.get("access-control-allow-origin")).toBeNull();
        const a = await a2a(base, "tasks/get", { id: "00000000-0000-4000-8000-000000000000" }, { key: k, ...from(origin) });
        expect(a.status, origin).toBe(403);
        expect(a.error).toMatchObject({ code: -32011, message: "Origin not allowed" });
      }
    }
    expect(await mesh.store.getAgentByXUserId("666")).toBeNull(); // nothing was registered
    expect(failed()).toBe(0); // the bad key was never even checked
    // The key still works from a real client.
    expect((await tool(base, "list_threads", {}, { key })).isError).toBe(false);
  });

  it("does not read the body, whatever its size or content type", async () => {
    const { base } = await setup();
    const huge = await streamRequest(base, "/mcp", { headers: { ...MCP_HEADERS, Origin: "https://evil.example", "Content-Length": String(50 * LIMITS.bodyBytes) }, chunks: ["{"] });
    expect(huge.status).toBe(403);
    const form = await realFetch(`${base}/a2a`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: "https://evil.example" }, body: "x" });
    expect(form.status).toBe(403); // 403 for the origin, not 415 for the type
    const notJson = await realFetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, Origin: "https://evil.example" }, body: "{not json" });
    expect(notJson.status).toBe(403);
  });

  it("covers every method, so a preflight learns nothing and gets no CORS grant", async () => {
    const { base } = await setup();
    for (const path of ["/mcp", "/a2a", "/mcp/", "/a2a/"]) {
      for (const method of ["OPTIONS", "GET", "DELETE", "PUT"]) {
        const res = await realFetch(`${base}${path}`, { method, headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" } });
        expect(res.status, `${method} ${path}`).toBe(403);
        for (const h of ["access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods", "access-control-allow-credentials"]) expect(res.headers.get(h)).toBeNull();
      }
    }
  });

  it("still counts against the per-IP request limit (the limit comes first)", async () => {
    const { base } = await setup({ httpRate: { capacity: 3, refillPerSec: 0.001 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await tool(base, "list_threads", {}, from("https://evil.example"))).status);
    expect(statuses).toEqual([403, 403, 403, 429, 429]);
  });
});

describe("allowed origins", () => {
  it("the public URL's own origin is accepted by default, in any spelling", async () => {
    const { base } = await setup();
    for (const origin of ["https://mesh.test", "https://MESH.TEST", "https://mesh.test:443"]) {
      const r = await tool(base, "list_threads", {}, from(origin));
      expect(r.status, origin).toBe(200);
      expect(r.body.error).toBe("unauthorized"); // it reached the tool, which wants a key
      const a = await a2a(base, "tasks/get", { id: "00000000-0000-4000-8000-000000000000" }, from(origin));
      expect(a.status).toBe(401);
    }
  });

  it("a configured list is used as given: listed origins pass, the rest (the public URL too, unless listed) do not", async () => {
    const { base } = await setup({ allowedOrigins: ["http://localhost:6274", "https://app.example.com"] });
    expect((await tool(base, "register_agent", reg("1"), from("http://localhost:6274"))).isError).toBe(false);
    expect((await tool(base, "register_agent", reg("2"), from("https://app.example.com"))).isError).toBe(false);
    expect((await tool(base, "register_agent", reg("3"), from("https://mesh.test"))).status).toBe(403);
    expect((await tool(base, "register_agent", reg("4"), from("http://localhost:6275"))).status).toBe(403);
    expect((await tool(base, "register_agent", reg("5"))).isError).toBe(false); // no Origin: always fine
  });

  it("* turns the check off", async () => {
    const { base } = await setup({ allowedOrigins: "*" });
    for (const origin of ["https://evil.example", "null", "garbage"]) expect((await tool(base, "list_threads", {}, from(origin))).status).toBe(200);
  });

  it("an empty list still serves agent clients", async () => {
    const { base } = await setup({ allowedOrigins: [] });
    expect((await tool(base, "register_agent", reg("1"))).isError).toBe(false);
    expect((await tool(base, "register_agent", reg("2"), from("https://mesh.test"))).status).toBe(403);
  });
});

describe("the other routes do not check Origin", () => {
  it("health, agent cards and the sign-in pages answer as before", async () => {
    const { base } = await setup();
    await tool(base, "register_agent", reg("1", "alice"));
    const h = { headers: { Origin: "https://evil.example" } };
    expect((await realFetch(`${base}/healthz`, h)).status).toBe(200);
    expect((await realFetch(`${base}/.well-known/agent-card.json`, h)).status).toBe(200);
    expect((await realFetch(`${base}/agents/alice/.well-known/agent-card.json`, h)).status).toBe(200);
    expect((await realFetch(`${base}/auth/x/login`, { ...h, redirect: "manual" })).status).toBe(503); // X sign-in is not configured in this test
    expect((await realFetch(`${base}/nope`, h)).status).toBe(404);
  });
});
