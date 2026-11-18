// The HTTP layer's own defences: client address handling (MESH_TRUST_PROXY), the per-IP request
// limit, body size limits, content types, malformed requests and what an error response may say.
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, testConfig } from "../src/config.js";
import { createHttpServer, ipKey } from "../src/http.js";
import { Mesh } from "../src/mesh.js";
import { MemoryStore } from "../src/store.js";
import { newMesh, register } from "./helpers.js";
import { a2a, a2aMessage, closeServers, MCP_HEADERS, rawRequest, serve, streamRequest, tool } from "./http-helpers.js";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await closeServers();
  errors.mockRestore();
});

const reg = (id: string) => ({ x_user_id: id, x_handle: `user_${id}`, owner_opt_in: true });
/** The keys the per-IP registration limiter has seen. */
const seenIps = (mesh: Mesh) => [...((mesh as any).ipLimiter.buckets as Map<string, unknown>).keys()];

describe("ipKey", () => {
  it("keeps IPv4 whole, folds IPv4-mapped IPv6 into it, and cuts IPv6 to its /64", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("::FFFF:cb00:7109")).toBe("203.0.113.9");
    expect(ipKey("0:0:0:0:0:ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(ipKey("2001:db8:1:2::"));
    expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipKey("64:ff9b::203.0.113.9")).toBe("64:ff9b:0:0::/64");
  });

  it("answers null for anything that is not an IP address", () => {
    for (const bad of [undefined, "", " ", "unknown", "localhost", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1.2.3.4:80", "[::1]", "[::1]:80", "::1::2", "1.2.3.4, 5.6.7.8", "a".repeat(5000), "1.2.3.4\r\nX: y", "<script>"]) {
      expect(ipKey(bad as string), String(bad).slice(0, 20)).toBeNull();
    }
  });
});

describe("client address (MESH_TRUST_PROXY)", () => {
  const once = { ipRate: { capacity: 1, refillPerSec: 0.0001 } };
  const registerFrom = (base: string, id: string, headers: Record<string, string>) => tool(base, "register_agent", reg(id), { headers });

  it("off: forwarding headers are ignored, so they cannot be used to dodge a limit", async () => {
    const mesh = newMesh({ ...once, trustProxy: false });
    const base = await serve(mesh);
    expect((await registerFrom(base, "1", { "X-Forwarded-For": "1.1.1.1", "Fly-Client-IP": "1.1.1.1" })).isError).toBe(false);
    const second = await registerFrom(base, "2", { "X-Forwarded-For": "2.2.2.2", "Fly-Client-IP": "2.2.2.2" });
    expect(second.body.error).toBe("rate_limited");
    expect(seenIps(mesh)).toEqual(["127.0.0.1"]);
  });

  it("1: the last X-Forwarded-For hop counts; earlier hops are the client's own claim", async () => {
    const mesh = newMesh({ ...once, trustProxy: true });
    const base = await serve(mesh);
    expect((await registerFrom(base, "1", { "X-Forwarded-For": "9.9.9.9, 1.1.1.1" })).isError).toBe(false);
    expect((await registerFrom(base, "2", { "X-Forwarded-For": "8.8.8.8, 1.1.1.1" })).body.error).toBe("rate_limited");
    expect((await registerFrom(base, "2", { "X-Forwarded-For": "1.1.1.1, 2.2.2.2" })).isError).toBe(false);
    // Fly-Client-IP means nothing in this mode.
    expect((await registerFrom(base, "3", { "X-Forwarded-For": "2.2.2.2", "Fly-Client-IP": "3.3.3.3" })).body.error).toBe("rate_limited");
    expect(seenIps(mesh)).toEqual(["1.1.1.1", "2.2.2.2"]);
  });

  it("fly: Fly-Client-IP counts, falling back to the last X-Forwarded-For hop, then the socket", async () => {
    const mesh = newMesh({ ...once, trustProxy: "fly" });
    const base = await serve(mesh);
    expect((await registerFrom(base, "1", { "Fly-Client-IP": "1.1.1.1", "X-Forwarded-For": "7.7.7.7" })).isError).toBe(false);
    expect((await registerFrom(base, "2", { "Fly-Client-IP": "1.1.1.1", "X-Forwarded-For": "6.6.6.6" })).body.error).toBe("rate_limited");
    expect((await registerFrom(base, "2", { "X-Forwarded-For": "5.5.5.5, 4.4.4.4" })).isError).toBe(false);
    expect((await registerFrom(base, "3", {})).isError).toBe(false);
    expect(seenIps(mesh)).toEqual(["1.1.1.1", "4.4.4.4", "127.0.0.1"]);
  });

  it("never uses header text that is not an IP address as a limiter key", async () => {
    const mesh = newMesh({ trustProxy: "fly" });
    const base = await serve(mesh);
    const junk = ["not-an-ip", "x".repeat(4000), "1.2.3.4:5678", "1.1.1.1, 2.2.2.2", "' or 1=1 --", "<script>alert(1)</script>"];
    for (const [i, value] of junk.entries()) {
      expect((await registerFrom(base, String(100 + i), { "Fly-Client-IP": value, "X-Forwarded-For": value })).isError, value.slice(0, 20)).toBe(false);
    }
    // "1.1.1.1, 2.2.2.2" as X-Forwarded-For does have a valid last hop; everything else fell back to the socket.
    expect(seenIps(mesh).sort()).toEqual(["127.0.0.1", "2.2.2.2"]);
    for (const limiter of ["ipLimiter", "authFailLimiter"]) {
      for (const key of ((mesh as any)[limiter].buckets as Map<string, unknown>).keys()) expect(ipKey(key) ?? key).toBe(key);
    }
  });

  it("gives one IPv6 /64 one bucket, and an IPv4-mapped address its IPv4 bucket", async () => {
    const mesh = newMesh({ ...once, trustProxy: "fly" });
    const base = await serve(mesh);
    expect((await registerFrom(base, "1", { "Fly-Client-IP": "2001:db8:aa:bb::1" })).isError).toBe(false);
    expect((await registerFrom(base, "2", { "Fly-Client-IP": "2001:db8:aa:bb:dead:beef:0:2" })).body.error).toBe("rate_limited");
    expect((await registerFrom(base, "2", { "Fly-Client-IP": "2001:db8:aa:bc::1" })).isError).toBe(false);
    expect((await registerFrom(base, "3", { "Fly-Client-IP": "::ffff:10.1.2.3" })).isError).toBe(false);
    expect((await registerFrom(base, "4", { "Fly-Client-IP": "10.1.2.3" })).body.error).toBe("rate_limited");
  });
});

describe("per-IP request limit", () => {
  it("answers 429 with Retry-After before parsing or authenticating, and leaves /healthz alone", async () => {
    let t = 1_800_000_000_000;
    const mesh = newMesh({ httpRate: { capacity: 3, refillPerSec: 0.1 }, trustProxy: "fly" }, () => t);
    const a = await register(mesh, "1", "alice");
    const base = await serve(mesh);
    const from = (ip: string) => ({ headers: { "Fly-Client-IP": ip }, key: a.key });
    for (let i = 0; i < 3; i++) expect((await tool(base, "list_threads", {}, from("1.1.1.1"))).status).toBe(200);

    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, "Fly-Client-IP": "1.1.1.1" }, body: "{not json" });
    expect(mcp.status).toBe(429); // not 400: the body was never read
    expect(mcp.headers.get("retry-after")).toBe("10");
    expect(mcp.headers.get("connection")).toBe("close");
    expect(await mcp.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32029, message: "Rate limit exceeded", data: { retry_after_seconds: 10 } } });

    const rpc = await a2a(base, "tasks/get", { id: "nope" }, from("1.1.1.1"));
    expect(rpc.status).toBe(429);
    expect(rpc.error).toMatchObject({ code: -32029 });
    for (const path of ["/.well-known/agent-card.json", "/agents/alice/.well-known/agent-card.json", "/auth/x/login", "/auth/x/callback?state=s", "/nope"]) {
      const res = await fetch(`${base}${path}`, { headers: { "Fly-Client-IP": "1.1.1.1" }, redirect: "manual" });
      expect(res.status, path).toBe(429);
      expect(await res.json()).toMatchObject({ error: "rate_limited", retry_after_seconds: 10 });
    }

    // The health check is never limited (Fly polls it), and other clients are unaffected.
    for (let i = 0; i < 10; i++) expect((await fetch(`${base}/healthz`, { headers: { "Fly-Client-IP": "1.1.1.1" } })).status).toBe(200);
    expect((await tool(base, "list_threads", {}, from("2.2.2.2"))).status).toBe(200);
    // Refused requests did not touch the per-agent or failed-auth limiters.
    expect(((mesh as any).authFailLimiter.buckets as Map<string, unknown>).size).toBe(0);

    t += 10_000;
    expect((await tool(base, "list_threads", {}, from("1.1.1.1"))).status).toBe(200);
  });

  it("bounds what one address can spend on failed authentication", async () => {
    const mesh = newMesh();
    const base = await serve(mesh);
    let last: Awaited<ReturnType<typeof tool>> | undefined;
    for (let i = 0; i < 40; i++) last = await tool(base, "list_threads", {}, { key: `xam_guess_${i}` });
    expect(last!.body.error).toBe("rate_limited");
    const rpc = await a2a(base, "tasks/get", { id: "x" }, { key: "xam_guess" });
    expect(rpc.status).toBe(429);
    expect(Number(rpc.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("request bodies", () => {
  it("refuses a body that declares more than the limit without reading it", async () => {
    const base = await serve(newMesh());
    for (const [path, limit] of [["/mcp", LIMITS.bodyBytes], ["/a2a", LIMITS.a2aBodyBytes]] as const) {
      const r = await streamRequest(base, path, { headers: { ...MCP_HEADERS, "Content-Length": String(limit + 1) }, chunks: ["{"] });
      expect(r.status, path).toBe(413);
      expect(r.headers.connection).toBe("close");
      expect(JSON.parse(r.body)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } });
    }
  });

  it("stops reading a chunked body once it passes the limit, and still answers 413", async () => {
    const base = await serve(newMesh());
    const piece = Buffer.alloc(65_536, "a");
    for (const [path, limit] of [["/mcp", LIMITS.bodyBytes], ["/a2a", LIMITS.a2aBodyBytes]] as const) {
      const chunks = Array.from({ length: limit / piece.length + 1 }, () => piece);
      const r = await streamRequest(base, path, { headers: MCP_HEADERS, chunks });
      expect(r.status, path).toBe(413);
      expect(JSON.parse(r.body).error.message).toBe("Request body too large");
    }
    // The server is still fine afterwards.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("accepts bodies up to the limit: /mcp takes two full id lists, /a2a has the smaller limit", async () => {
    const mesh = newMesh();
    const a = await register(mesh, "1", "alice");
    const base = await serve(mesh);
    const ids = Array.from({ length: LIMITS.ids }, (_, i) => String(10_000_000_000_000_000_000n + BigInt(i)));
    const big = await tool(base, "list_mutual_agents", { follower_ids: ids, following_ids: ids }, { key: a.key });
    expect(big.status).toBe(200);
    expect(big.body.mutual_count).toBe(LIMITS.ids);

    const padding = "p".repeat(LIMITS.a2aBodyBytes);
    const res = await fetch(`${base}/a2a`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x", metadata: { padding } } }) });
    expect(res.status).toBe(413);
    const fits = await a2a(base, "tasks/get", { id: "x", metadata: { padding: padding.slice(0, LIMITS.a2aBodyBytes - 1000) } }, { key: a.key });
    expect(fits.status).toBe(200);
    expect(fits.error?.code).toBe(-32602); // read and validated: "x" is not a thread id
  });

  it("answers parse errors without echoing the body", async () => {
    const base = await serve(newMesh());
    const secretish = `{"token":"s3cr3t-in-body",`;
    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: secretish });
    expect(mcp.status).toBe(400);
    const mcpText = await mcp.text();
    expect(JSON.parse(mcpText)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    const rpc = await fetch(`${base}/a2a`, { method: "POST", headers: { "Content-Type": "application/json" }, body: secretish });
    const rpcText = await rpc.text();
    expect(JSON.parse(rpcText)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(mcpText + rpcText).not.toContain("s3cr3t");
    for (const body of ["", "null", "[]", "42", `"str"`, `{"jsonrpc":"2.0","method":"tasks/get"}`, `{"jsonrpc":"1.0","id":1,"method":"tasks/get"}`, `{"jsonrpc":"2.0","id":{},"method":"tasks/get"}`, `{"jsonrpc":"2.0","id":1,"method":7}`]) {
      const r = await fetch(`${base}/a2a`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const j: any = await r.json();
      expect([-32700, -32600], body).toContain(j.error.code);
    }
    expect(errors).not.toHaveBeenCalled();
  });

  it("refuses a non-JSON content type on /a2a, but not a missing one", async () => {
    const mesh = newMesh();
    const a = await register(mesh, "1", "alice");
    const base = await serve(mesh);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "00000000-0000-4000-8000-000000000000" } });
    const post = (type: string | undefined) => fetch(`${base}/a2a`, { method: "POST", headers: { Authorization: `Bearer ${a.key}`, ...(type === undefined ? {} : { "Content-Type": type }) }, body: type === undefined ? Buffer.from(body) : body });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/html", "application/jsonx"]) {
      const res = await post(type);
      expect(res.status, type).toBe(415);
      expect(((await res.json()) as any).error.code).toBe(-32600);
    }
    for (const type of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON", "application/a2a+json", undefined]) {
      const res = await post(type);
      expect(res.status, String(type)).toBe(200);
      expect(((await res.json()) as any).error.code).toBe(-32001); // reached the handler: no such task
    }
  });

  it("goes quiet when a client disconnects mid-body: no log line, no crash", async () => {
    const mesh = newMesh();
    const base = await serve(mesh);
    const { hostname, port } = new URL(base);
    for (const path of ["/mcp", "/a2a"]) {
      await new Promise<void>((resolve) => {
        const socket = connect(Number(port), hostname, () => {
          socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"partial":`);
          setTimeout(() => socket.destroy(), 30);
        });
        socket.on("close", () => setTimeout(resolve, 50));
        socket.on("error", () => {});
      });
    }
    expect(errors).not.toHaveBeenCalled();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("malformed requests and methods", () => {
  it("answers 400, not 500, to a request target that is not a URL", async () => {
    const base = await serve(newMesh());
    const out = await rawRequest(base, "GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(out).toMatch(/^HTTP\/1\.1 400 /);
    expect(out).toContain(`"error":"bad_request"`);
    expect(errors).not.toHaveBeenCalled();
  });

  it("ignores a host or scheme smuggled into the request target", async () => {
    const base = await serve(newMesh());
    for (const target of ["//evil.example/healthz", "http://evil.example/healthz", "/healthz?x=//evil.example", "/healthz/"]) {
      const out = await rawRequest(base, `GET ${target} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
      expect(out, target).toMatch(/^HTTP\/1\.1 200 /);
      expect(out).not.toMatch(/^location:/im);
    }
    // No route redirects anywhere but X's authorize URL (see the OAuth tests); nothing reflects the Host header.
    const card: any = await (await fetch(`${base}/.well-known/agent-card.json`, { headers: { "X-Forwarded-Host": "evil.example" } })).json();
    expect(card.url).toBe("https://mesh.test/a2a");
  });

  it("allows only the documented method on each route", async () => {
    const base = await serve(newMesh());
    const status = async (method: string, path: string) => (await fetch(`${base}${path}`, { method })).status;
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      expect(await status(method, "/mcp"), `${method} /mcp`).toBe(405);
      expect(await status(method, "/a2a"), `${method} /a2a`).toBe(405);
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(await status(method, "/auth/x/login")).toBe(405);
      expect(await status(method, "/auth/x/callback")).toBe(405);
      expect(await status(method, "/healthz")).toBe(404);
      expect(await status(method, "/.well-known/agent-card.json")).toBe(404);
      expect(await status(method, "/agents/alice/.well-known/agent-card.json")).toBe(404);
    }
    // No CORS: a browser page on another origin cannot read anything or send a bearer key.
    const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" } });
    expect(preflight.status).toBe(403); // refused for its Origin before the method is looked at (test/origin.test.ts)
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/mcp`, { method: "OPTIONS" })).status).toBe(405); // without an Origin: the method answer, as before
    expect((await fetch(`${base}/healthz`, { headers: { Origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("looks up agent cards only for well-formed handles", async () => {
    const mesh = newMesh();
    await register(mesh, "1", "alice");
    const lookups = vi.spyOn(mesh.store, "getAgentByHandle");
    const base = await serve(mesh);
    for (const handle of ["a".repeat(16), "al%20ice", "alice%00", "al.ice", "al-ice", "alice%27%20or%201=1", "%E0%A4%A", "%ff", "<script>"]) {
      const res = await fetch(`${base}/agents/${handle}/.well-known/agent-card.json`);
      expect(res.status, handle).toBe(404);
      expect(await res.text()).not.toContain("<script>");
    }
    expect(lookups).not.toHaveBeenCalled();
    expect((await fetch(`${base}/agents/@alice/.well-known/agent-card.json`)).status).toBe(200);
    expect((await fetch(`${base}/agents/%40ALICE/.well-known/agent-card.json/`)).status).toBe(200);
  });

  it("sets short timeouts for slow senders", () => {
    const server = createHttpServer(newMesh());
    expect(server.requestTimeout).toBeLessThanOrEqual(30_000);
    expect(server.headersTimeout).toBeLessThanOrEqual(15_000);
    expect(server.headersTimeout).toBeLessThan(server.requestTimeout);
  });
});

describe("response headers", () => {
  it("marks JSON as JSON, uncacheable and not sniffable; adds HSTS when the public URL is https", async () => {
    const base = await serve(newMesh());
    for (const path of ["/healthz", "/nope", "/agents/x/.well-known/agent-card.json"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get("content-type"), path).toBe("application/json; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    }
    const local = await serve(newMesh({ publicUrl: "http://localhost:8787" }));
    expect((await fetch(`${local}/healthz`)).headers.get("strict-transport-security")).toBeNull();
  });
});

describe("unexpected failures", () => {
  /** A store whose reads fail with a message that must never reach a caller. */
  class BrokenStore extends MemoryStore {
    broken = false;
    private fail(): never {
      throw new Error("SQLITE_CORRUPT at /data/mesh.db: api_key_hash=deadbeef secret-internal-detail");
    }
    override async getAgentByKeyHash(hash: string) {
      if (this.broken) this.fail();
      return super.getAgentByKeyHash(hash);
    }
    override async getAgentByHandle(handle: string) {
      if (this.broken) this.fail();
      return super.getAgentByHandle(handle);
    }
    override async getAgentByXUserId(id: string) {
      if (this.broken) this.fail();
      return super.getAgentByXUserId(id);
    }
  }

  it("tell the caller only that something failed, on every surface; the detail goes to the log", async () => {
    const store = new BrokenStore();
    const mesh = new Mesh(store, testConfig());
    const a = await register(mesh, "1", "alice");
    const base = await serve(mesh);
    store.broken = true;

    const viaTool = await tool(base, "list_threads", {}, { key: a.key });
    expect(viaTool.status).toBe(200);
    expect(viaTool.isError).toBe(true);
    expect(viaTool.body).toEqual({ error: "internal", message: "The mesh could not complete this request. Try again later." });
    const viaRegister = await tool(base, "register_agent", reg("2"));
    expect(viaRegister.body.error).toBe("internal");

    const viaA2a = await a2a(base, "tasks/get", { id: "00000000-0000-4000-8000-000000000000" }, { key: a.key });
    expect(viaA2a.error).toEqual({ code: -32603, message: "Internal error" });

    const card = await fetch(`${base}/agents/alice/.well-known/agent-card.json`);
    expect(card.status).toBe(500);
    const cardText = await card.text();
    expect(JSON.parse(cardText)).toEqual({ error: "internal" });

    const everything = JSON.stringify([viaTool.body, viaRegister.body, viaA2a, cardText]);
    for (const leak of ["SQLITE", "/data/mesh.db", "deadbeef", "secret-internal-detail", "at ", ".ts:"]) expect(everything, leak).not.toContain(leak);
    // The operator still sees it.
    expect(JSON.stringify(errors.mock.calls.map((c: unknown[]) => c.map(String)))).toContain("secret-internal-detail");
    // And never the caller's key.
    expect(JSON.stringify(errors.mock.calls.map((c: unknown[]) => c.map(String)))).not.toContain(a.key);
  });

  it("a2a proposals with odd shapes are refused as invalid params, never as internal errors", async () => {
    const mesh = newMesh();
    const a = await register(mesh, "1", "alice");
    const base = await serve(mesh);
    const deep = JSON.parse(`${"[".repeat(500)}${"]".repeat(500)}`);
    const cases: unknown[] = [
      undefined,
      null,
      [],
      "string",
      {},
      { message: null },
      { message: { role: "admin", messageId: "m", parts: [{ kind: "text", text: "x" }] } },
      { message: { role: "user", messageId: "", parts: [{ kind: "text", text: "x" }] } },
      { message: { role: "user", messageId: "m".repeat(129), parts: [{ kind: "text", text: "x" }] } },
      { message: { role: "user", messageId: "m", parts: [] } },
      { message: { role: "user", messageId: "m", parts: Array.from({ length: 11 }, () => ({ kind: "text", text: "x" })) } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x".repeat(LIMITS.text + 1) }] } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "image", url: "x" }] } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "data", data: "not an object" }] } },
      { message: { role: "user", messageId: "m", taskId: "not-a-uuid", parts: [{ kind: "text", text: "x" }] } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x" }], referenceTaskIds: Array.from({ length: 101 }, () => "t") } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x" }], referenceTaskIds: ["r".repeat(129)] } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x" }], extensions: Array.from({ length: 101 }, () => "e") } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x" }], metadata: { to_x_user_id: "1; drop table mesh_agents" } } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x" }], metadata: { to_x_user_id: 2 } } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x" }], metadata: { to_x_user_ids: Array.from({ length: 21 }, (_, i) => String(i + 10)) } } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x" }], metadata: { to_x_user_id: deep } } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "   " }], metadata: { to_x_user_id: "2" } } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x" }] }, configuration: { historyLength: -1 } },
      { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "x" }] }, configuration: { historyLength: 1.5 } },
    ];
    for (const params of cases) {
      const r = await a2a(base, "message/send", params, { key: a.key });
      expect(r.status).toBe(200);
      expect(r.error?.code, JSON.stringify(params)?.slice(0, 120)).toBe(-32602);
      // Issue lists are short and say where, never what was sent.
      if (Array.isArray(r.error?.data)) expect(r.error.data.length).toBeLessThanOrEqual(10);
    }
    for (const [method, params] of [["tasks/get", { id: "x" }], ["tasks/get", { id: "00000000-0000-4000-8000-000000000000", historyLength: -1 }], ["tasks/get", {}], ["tasks/cancel", { id: 5 }], ["tasks/cancel", null]] as const) {
      expect((await a2a(base, method, params, { key: a.key })).error?.code, method).toBe(-32602);
    }
    expect(errors).not.toHaveBeenCalled();
    expect((await a2a(base, "message/send", a2aMessage("ok"), { key: a.key })).error?.code).toBe(-32602); // no recipient
  });
});
