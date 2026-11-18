// Shared by the HTTP integration tests: a loopback server per test, a fake X (no real network or
// credentials), and small clients for /mcp and /a2a.
import { request, type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { vi } from "vitest";
import { createHttpServer } from "../src/http.js";
import type { Mesh } from "../src/mesh.js";

// Fakes: no real X credentials exist in this repo or its tests.
export const CLIENT_ID = "fake-client-id";
export const CLIENT_SECRET = "fake-client-secret-do-not-leak";
export const ACCESS_TOKEN = "fake-access-token-do-not-leak";
export const xOAuth = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: "https://mesh.test/auth/x/callback", scopes: "users.read tweet.read" };

/** The real fetch, for talking to the loopback test server while the global one is stubbed. */
export const realFetch = globalThis.fetch;

let closers: (() => Promise<void>)[] = [];

/** Starts the HTTP server for `mesh` on a loopback port. Call `closeServers()` in afterEach. */
export async function serve(mesh: Mesh): Promise<string> {
  const server = createHttpServer(mesh);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function closeServers() {
  for (const close of closers) await close();
  closers = [];
}

export interface XCall {
  url: string;
  init: RequestInit;
}

export interface FakeX {
  tokenStatus: number;
  tokenBody: unknown;
  meStatus: number;
  /** The /2/users/me body; set per test to choose who "signs in". */
  me: unknown;
  calls: XCall[];
  /** When set, replaces the whole answer for one endpoint. */
  respond?: (url: string) => Response | Promise<Response> | undefined;
}

/**
 * Replaces global fetch with a fake X: only the token and users/me endpoints exist, anything else
 * outbound throws. Requests to the loopback test server go to the real fetch. Undo with
 * vi.unstubAllGlobals().
 */
export function fakeX(): FakeX {
  const x: FakeX = {
    tokenStatus: 200,
    tokenBody: { token_type: "bearer", access_token: ACCESS_TOKEN, scope: "users.read tweet.read", expires_in: 7200 },
    meStatus: 200,
    me: { data: { id: "1", name: "Alice", username: "alice" } },
    calls: [],
  };
  const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    x.calls.push({ url, init });
    const custom = await x.respond?.(url);
    if (custom) return custom;
    if (url === "https://api.x.com/2/oauth2/token") return jsonResponse(x.tokenStatus, x.tokenBody);
    if (url === "https://api.x.com/2/users/me") return jsonResponse(x.meStatus, x.me);
    throw new Error(`unexpected outbound request to ${url}`);
  });
  return x;
}

/** GET /auth/x/login without following the redirect. */
export async function login(url: string, headers: Record<string, string> = {}) {
  const res = await realFetch(url, { redirect: "manual", headers });
  const location = res.headers.get("location");
  const setCookie = res.headers.get("set-cookie") ?? "";
  const authorize = location ? new URL(location) : null;
  return { res, status: res.status, setCookie, cookie: setCookie.split(";")[0] ?? "", authorize, location, state: authorize?.searchParams.get("state") ?? "" };
}

export async function callback(base: string, params: Record<string, string>, cookie?: string, headers: Record<string, string> = {}) {
  const res = await realFetch(`${base}/auth/x/callback?${new URLSearchParams(params)}`, { headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) } });
  return { res, status: res.status, html: await res.text() };
}

export const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

export interface ToolReply {
  status: number;
  isError: boolean;
  /** The tool's JSON result, or the SDK's plain-text validation error. */
  body: any;
  headers: Headers;
}

/** One MCP tools/call over POST /mcp. */
export async function tool(base: string, name: string, args: Record<string, unknown> = {}, opts: { key?: string; headers?: Record<string, string> } = {}): Promise<ToolReply> {
  const res = await realFetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}), ...opts.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const json = (await res.json()) as any;
  if (!json.result) return { status: res.status, isError: true, body: json, headers: res.headers };
  const text: string = json.result.content?.[0]?.text ?? "";
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* SDK validation errors are plain text */
  }
  return { status: res.status, isError: Boolean(json.result.isError), body, headers: res.headers };
}

/** One A2A JSON-RPC call over POST /a2a. */
export async function a2a(base: string, method: string, params: unknown, opts: { key?: string; headers?: Record<string, string> } = {}) {
  const res = await realFetch(`${base}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}), ...opts.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params }),
  });
  const json = (await res.json()) as { result?: any; error?: { code: number; message: string; data?: any } };
  return { status: res.status, headers: res.headers, ...json };
}

export const a2aMessage = (text: string, extra: Record<string, unknown> = {}) => ({ message: { kind: "message", role: "user", messageId: `m-${Math.random().toString(36).slice(2)}`, parts: [{ kind: "text", text }], ...extra } });

export interface RawReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A request whose body is streamed in pieces (chunked unless `headers` sets Content-Length), for
 * the body-limit tests. It waits for the answer before ending the request, as the server may answer
 * (and close) before the whole body was sent.
 */
export function streamRequest(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; chunks?: (string | Buffer)[] }): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: opts.method ?? "POST", headers: opts.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => {
        req.destroy();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.flushHeaders();
    for (const chunk of opts.chunks ?? []) req.write(chunk);
  });
}

/** Writes raw bytes to the server and returns whatever it sends back before closing. */
export function rawRequest(base: string, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const socket = connect(Number(port), hostname, () => socket.write(bytes));
    let out = "";
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => (out += d));
    socket.on("close", () => resolve(out));
    socket.on("error", reject);
    socket.setTimeout(5000, () => socket.destroy());
  });
}
