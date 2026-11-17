import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type MeshConfig } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import type { Mesh } from "../src/mesh.js";
import { STATE_TTL_MS, TICKET_TTL_MS } from "../src/xauth.js";
import { call, newMesh, register } from "./helpers.js";

// Fakes: no real X credentials exist in this repo or its tests.
const CLIENT_ID = "fake-client-id";
const CLIENT_SECRET = "fake-client-secret";
const ACCESS_TOKEN = "fake-access-token-do-not-leak";
const xOAuth = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: "https://mesh.test/auth/x/callback", scopes: "users.read tweet.read" };

const realFetch = globalThis.fetch;
interface XCall {
  url: string;
  init: RequestInit;
}
/** What the fake X answers. Requests to the local test server pass through to the real fetch. */
let x: { tokenStatus: number; tokenBody: unknown; meStatus: number; me: unknown; calls: XCall[] };
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let servers: (() => Promise<void>)[] = [];
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  x = { tokenStatus: 200, tokenBody: { token_type: "bearer", access_token: ACCESS_TOKEN, scope: "users.read tweet.read", expires_in: 7200 }, meStatus: 200, me: { data: { id: "1", name: "Alice", username: "alice" } }, calls: [] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    x.calls.push({ url, init });
    if (url === "https://api.x.com/2/oauth2/token") return jsonResponse(x.tokenStatus, x.tokenBody);
    if (url === "https://api.x.com/2/users/me") return jsonResponse(x.meStatus, x.me);
    throw new Error(`unexpected outbound request to ${url}`);
  });
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of servers) await close();
  servers = [];
  // Nothing secret may reach the logs.
  const logged = JSON.stringify(errors.mock.calls);
  for (const secret of [CLIENT_SECRET, ACCESS_TOKEN]) expect(logged).not.toContain(secret);
  errors.mockRestore();
});

async function serve(mesh: Mesh): Promise<string> {
  const server = createHttpServer(mesh);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup(over: Partial<MeshConfig> = {}, now?: () => number) {
  const mesh = newMesh({ xOAuth, ...over }, now);
  const base = await serve(mesh);
  /** verify_url points at the public URL; the test server listens elsewhere. */
  const local = (verifyUrl: string) => verifyUrl.replace("https://mesh.test", base);
  return { mesh, base, local };
}

/** GET /auth/x/login without following the redirect. */
async function login(url: string) {
  const res = await realFetch(url, { redirect: "manual" });
  const location = res.headers.get("location");
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { res, setCookie, cookie: setCookie.split(";")[0] ?? "", authorize: location ? new URL(location) : null, location };
}

async function callback(base: string, params: Record<string, string>, cookie?: string) {
  const res = await realFetch(`${base}/auth/x/callback?${new URLSearchParams(params)}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { res, status: res.status, html: await res.text() };
}

/** Registers an agent with X OAuth configured and returns it with its verify_url. */
async function registered(mesh: Mesh, id = "1", handle = "alice") {
  const r = await call(mesh, { ip: `ip-${id}` }, "register_agent", { x_user_id: id, x_handle: handle, owner_opt_in: true });
  expect(r.isError).toBe(false);
  return { key: r.body.api_key as string, ctx: { apiKey: r.body.api_key as string, ip: `ip-${id}` }, verifyUrl: r.body.verify_url as string, body: r.body };
}

/** The whole flow for one agent: login, then the callback as the same browser. */
async function verify(s: Awaited<ReturnType<typeof setup>>, verifyUrl: string) {
  const l = await login(s.local(verifyUrl));
  expect(l.res.status).toBe(302);
  return callback(s.base, { code: "auth-code", state: l.authorize!.searchParams.get("state")! }, l.cookie);
}

describe("config and availability", () => {
  it("is configured only when both the client id and secret are set; the redirect URI defaults to the public URL", () => {
    const off = loadConfig({ MESH_PUBLIC_URL: "https://m.example/" });
    expect(off.xOAuth).toEqual({ clientId: "", clientSecret: "", redirectUri: "https://m.example/auth/x/callback", scopes: "users.read tweet.read" });
    expect(newMesh({ xOAuth: off.xOAuth }).xauth.configured).toBe(false);
    expect(newMesh({ xOAuth: loadConfig({ X_CLIENT_ID: "id" }).xOAuth }).xauth.configured).toBe(false);
    expect(newMesh({ xOAuth: loadConfig({ X_CLIENT_SECRET: "s" }).xOAuth }).xauth.configured).toBe(false);
    const on = loadConfig({ X_CLIENT_ID: "id", X_CLIENT_SECRET: "s", X_REDIRECT_URI: "https://other.example/cb", X_OAUTH_SCOPES: " users.read   tweet.read " });
    expect(on.xOAuth).toEqual({ clientId: "id", clientSecret: "s", redirectUri: "https://other.example/cb", scopes: "users.read tweet.read" });
    expect(newMesh({ xOAuth: on.xOAuth }).xauth.configured).toBe(true);
    expect(() => loadConfig({ X_OAUTH_SCOPES: "users.read offline.access" })).toThrow(/offline\.access/);
  });

  it("answers 503 on /auth/x/* and reports x_oauth: disabled when not configured", async () => {
    const mesh = newMesh();
    const base = await serve(mesh);
    for (const path of ["/auth/x/login", "/auth/x/login?ticket=abc", "/auth/x/callback?code=c&state=s"]) {
      const res = await realFetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(503);
      expect(await res.text()).toContain("not configured");
    }
    expect(((await (await realFetch(`${base}/healthz`)).json()) as any).x_oauth).toBe("disabled");
    const r = await call(mesh, { ip: "a" }, "register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true });
    expect(r.body.verify_url).toBeUndefined();
    const s = await call(mesh, { ip: "a", apiKey: r.body.api_key }, "start_x_verification");
    expect(s.isError).toBe(true);
    expect(s.body.message).toContain("not configured");
    expect(x.calls).toEqual([]);
  });

  it("reports x_oauth: configured on /healthz without the values, and only accepts GET", async () => {
    const { base } = await setup();
    const text = await (await realFetch(`${base}/healthz`)).text();
    expect(JSON.parse(text).x_oauth).toBe("configured");
    expect(text).not.toContain(CLIENT_ID);
    expect(text).not.toContain(CLIENT_SECRET);
    expect((await realFetch(`${base}/auth/x/login`, { method: "POST" })).status).toBe(405);
    expect((await realFetch(`${base}/auth/x/callback`, { method: "POST" })).status).toBe(405);
  });
});

describe("tickets", () => {
  it("register_agent returns a verify_url with a random ticket; only its hash is kept", async () => {
    const { mesh } = await setup();
    const a = await registered(mesh);
    expect(a.verifyUrl).toMatch(/^https:\/\/mesh\.test\/auth\/x\/login\?ticket=[A-Za-z0-9_-]{43}$/);
    expect(a.body.x_verified).toBe(false);
    expect(a.body.verify_note).toContain("@alice");
    const ticket = new URL(a.verifyUrl).searchParams.get("ticket")!;
    const kept = JSON.stringify([...(mesh.xauth as any).tickets.entries()]);
    expect(kept).not.toContain(ticket);
    expect(kept).toContain(createHash("sha256").update(ticket).digest("hex"));
  });

  it("start_x_verification requires the agent's key and returns a fresh verify_url that replaces the old one", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const none = await call(s.mesh, { ip: "z" }, "start_x_verification");
    expect(none.isError).toBe(true);
    expect(none.body.error).toBe("unauthorized");
    expect((await call(s.mesh, { ip: "z", apiKey: "xam_wrong" }, "start_x_verification")).body.error).toBe("unauthorized");

    const fresh = await call(s.mesh, a.ctx, "start_x_verification");
    expect(fresh.isError).toBe(false);
    expect(fresh.body).toMatchObject({ x_user_id: "1", x_handle: "alice", x_verified: false });
    expect(fresh.body.verify_url).toMatch(/\/auth\/x\/login\?ticket=[A-Za-z0-9_-]{43}$/);
    expect(fresh.body.verify_url).not.toBe(a.verifyUrl);
    expect((await login(s.local(a.verifyUrl))).res.status).toBe(400); // replaced
    expect((await login(s.local(fresh.body.verify_url))).res.status).toBe(302);
  });

  it("start_x_verification is rate limited like any other tool, and refuses over stdio", async () => {
    const s = await setup({ agentRate: { capacity: 1, refillPerSec: 0.001 } });
    const a = await registered(s.mesh);
    expect((await call(s.mesh, a.ctx, "start_x_verification")).isError).toBe(false);
    expect((await call(s.mesh, a.ctx, "start_x_verification")).body.error).toBe("rate_limited");
    const viaStdio = await call(newMesh({ xOAuth }), { ip: "stdio" }, "register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true });
    expect(viaStdio.body.verify_url).toBeUndefined();
    expect(viaStdio.body.verify_note).toContain("hosted server");
  });

  it("rejects an unknown, empty or expired ticket without redirecting", async () => {
    let t = 1_800_000_000_000;
    const s = await setup({}, () => t);
    const a = await registered(s.mesh);
    for (const bad of ["nope", "", "A".repeat(43)]) {
      const l = await login(`${s.base}/auth/x/login?ticket=${bad}`);
      expect(l.res.status, bad).toBe(400);
      expect(l.location).toBeNull();
      expect(l.setCookie).toBe("");
    }
    t += TICKET_TTL_MS - 1000;
    expect((await login(s.local(a.verifyUrl))).res.status).toBe(302);
    t += 2000;
    const late = await login(s.local(a.verifyUrl));
    expect(late.res.status).toBe(400);
    expect(await late.res.text()).toContain("start_x_verification");
  });

  it("is one-time: after a successful verification the same link no longer works", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    // Two sign-ins started from the same link before either finished.
    const first = await login(s.local(a.verifyUrl));
    const second = await login(s.local(a.verifyUrl));
    expect((await callback(s.base, { code: "c", state: first.authorize!.searchParams.get("state")! }, first.cookie)).status).toBe(200);
    expect((await login(s.local(a.verifyUrl))).res.status).toBe(400);
    const replay = await callback(s.base, { code: "c", state: second.authorize!.searchParams.get("state")! }, second.cookie);
    expect(replay.status).toBe(400);
    expect(replay.html).toContain("already used");
    expect(x.calls).toHaveLength(2); // the replay never reached X
  });
});

describe("GET /auth/x/login", () => {
  it("redirects to X with the client id, redirect URI, scopes, state and an S256 challenge", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const l = await login(s.local(a.verifyUrl));
    expect(l.res.status).toBe(302);
    expect(l.location).toMatch(/^https:\/\/x\.com\/i\/oauth2\/authorize\?/);
    expect(l.location).toContain("scope=users.read%20tweet.read");
    const q = l.authorize!.searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ response_type: "code", client_id: CLIENT_ID, redirect_uri: "https://mesh.test/auth/x/callback", scope: "users.read tweet.read", code_challenge_method: "S256" });
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(l.location).not.toContain(CLIENT_SECRET);
    expect(l.location).not.toContain("offline.access");
    expect(l.location).not.toContain(new URL(a.verifyUrl).searchParams.get("ticket")!);

    // The server keeps the verifier (43-128 unreserved characters); the challenge is its SHA-256.
    const [pending] = [...(s.mesh.xauth as any).pending.values()];
    expect(pending.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(createHash("sha256").update(pending.verifier).digest("base64url")).toBe(q.get("code_challenge"));
    expect(l.location).not.toContain(pending.verifier);

    // The cookie binds this browser to the state; only its hash is kept.
    expect(l.setCookie).toMatch(/^xam_oauth=[A-Za-z0-9_-]{43}; Path=\/auth\/x; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
    expect(pending.cookieHash).toBe(createHash("sha256").update(l.cookie.split("=")[1]!).digest("hex"));
    expect(l.res.headers.get("cache-control")).toBe("no-store");
  });

  it("omits Secure on the cookie when the public URL is plain http (local development)", async () => {
    const s = await setup({ publicUrl: "http://localhost:8787" });
    const l = await login(`${s.base}/auth/x/login`);
    expect(l.setCookie).toContain("HttpOnly; SameSite=Lax");
    expect(l.setCookie).not.toContain("Secure");
  });

  it("without a ticket runs in whoami mode: shows who signed in, changes no agent, issues no key", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const before = await s.mesh.store.getAgentByXUserId("1");
    const l = await login(`${s.base}/auth/x/login`);
    expect(l.res.status).toBe(302);
    expect(l.authorize!.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(l.authorize!.searchParams.get("code_challenge_method")).toBe("S256");
    const c = await callback(s.base, { code: "c", state: l.authorize!.searchParams.get("state")! }, l.cookie);
    expect(c.status).toBe(200);
    expect(c.html).toContain("@alice (X user id 1)");
    expect(c.html).toContain("No agent was changed");
    expect(c.html).toContain("start_x_verification");
    expect(c.html).not.toContain("xam_");
    expect(await s.mesh.store.getAgentByXUserId("1")).toEqual(before); // still unverified, same key hash
    expect((await call(s.mesh, a.ctx, "list_threads")).isError).toBe(false);
  });

  it("limits sign-in starts per IP", async () => {
    const s = await setup();
    let last = 302;
    for (let i = 0; i < 25 && last === 302; i++) last = (await login(`${s.base}/auth/x/login`)).res.status;
    expect(last).toBe(429);
  });
});

describe("GET /auth/x/callback", () => {
  it("exchanges the code with Basic auth and the PKCE verifier, then marks the agent verified", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const l = await login(s.local(a.verifyUrl));
    const verifier = [...(s.mesh.xauth as any).pending.values()][0].verifier as string;
    const c = await callback(s.base, { code: "the-code", state: l.authorize!.searchParams.get("state")! }, l.cookie);
    expect(c.status).toBe(200);
    expect(c.html).toContain("X account verified");
    expect(c.html).toContain("@alice (X user id 1)");
    expect(c.res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(c.res.headers.get("cache-control")).toBe("no-store");
    expect(c.res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(c.res.headers.get("set-cookie")).toContain("xam_oauth=; Path=/auth/x; Max-Age=0"); // cleared

    expect(x.calls.map((k) => k.url)).toEqual(["https://api.x.com/2/oauth2/token", "https://api.x.com/2/users/me"]);
    const [tokenCall, meCall] = x.calls as [XCall, XCall];
    expect(tokenCall.init.method).toBe("POST");
    const headers = tokenCall.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(tokenCall.init.body as string))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://mesh.test/auth/x/callback",
      code_verifier: verifier,
      client_id: CLIENT_ID,
    });
    expect(tokenCall.init.body as string).not.toContain(CLIENT_SECRET);
    expect(tokenCall.init.signal).toBeInstanceOf(AbortSignal);
    expect((meCall.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(meCall.init.signal).toBeInstanceOf(AbortSignal);

    const row = await s.mesh.store.getAgentByXUserId("1");
    expect(row).toMatchObject({ x_verified: true, x_handle: "alice" });
    // The token is in neither the page nor the store.
    expect(c.html).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(row)).not.toContain(ACCESS_TOKEN);
    expect((s.mesh.xauth as any).pending.size).toBe(0);
    const again = await call(s.mesh, a.ctx, "start_x_verification");
    expect(again.body.x_verified).toBe(true);
  });

  it("rejects a missing, unknown, expired or replayed state", async () => {
    let t = 1_800_000_000_000;
    const s = await setup({}, () => t);
    const a = await registered(s.mesh);
    const l = await login(s.local(a.verifyUrl));
    const state = l.authorize!.searchParams.get("state")!;
    expect((await callback(s.base, { code: "c" }, l.cookie)).status).toBe(400);
    expect((await callback(s.base, { code: "c", state: "" }, l.cookie)).status).toBe(400);
    expect((await callback(s.base, { code: "c", state: "x".repeat(43) }, l.cookie)).status).toBe(400);
    t += STATE_TTL_MS + 1000;
    const late = await callback(s.base, { code: "c", state }, l.cookie);
    expect(late.status).toBe(400);
    expect(late.html).toContain("expired");
    expect(x.calls).toEqual([]);
    expect((await s.mesh.store.getAgentByXUserId("1"))!.x_verified).toBe(false);

    t -= STATE_TTL_MS; // a fresh sign-in, then its state replayed
    const l2 = await login(s.local(a.verifyUrl));
    const state2 = l2.authorize!.searchParams.get("state")!;
    expect((await callback(s.base, { code: "c", state: state2 }, l2.cookie)).status).toBe(200);
    expect((await callback(s.base, { code: "c", state: state2 }, l2.cookie)).status).toBe(400);
  });

  it("rejects a callback without the browser's cookie, or with another browser's (login CSRF)", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const victim = await login(s.local(a.verifyUrl));
    const other = await login(`${s.base}/auth/x/login`);
    const state = victim.authorize!.searchParams.get("state")!;
    for (const cookie of [undefined, "xam_oauth=", `xam_oauth=${"A".repeat(43)}`, other.cookie, "unrelated=1"]) {
      const c = await callback(s.base, { code: "c", state }, cookie);
      expect(c.status, String(cookie)).toBe(400);
      expect(c.html).toContain("not started in this browser");
    }
    expect(x.calls).toEqual([]);
    expect((await s.mesh.store.getAgentByXUserId("1"))!.x_verified).toBe(false);
    // The right browser can still finish.
    expect((await callback(s.base, { code: "c", state }, `other=1; ${victim.cookie}`)).status).toBe(200);
  });

  it("does not verify when the signed-in X account is not the registered one", async () => {
    const s = await setup();
    const a = await registered(s.mesh, "1", "alice");
    x.me = { data: { id: "666", name: "Mallory", username: "mallory" } };
    const c = await verify(s, a.verifyUrl);
    expect(c.status).toBe(403);
    expect(c.html).toContain("Not verified");
    expect(c.html).toContain("@mallory (X user id 666)");
    expect(c.html).toContain("registered for X user id 1");
    expect(await s.mesh.store.getAgentByXUserId("1")).toMatchObject({ x_verified: false, x_handle: "alice" });
    // Same handle, different id: the id is what counts.
    x.me = { data: { id: "2", username: "alice" } };
    expect((await verify(s, a.verifyUrl)).status).toBe(403);
    expect((await s.mesh.store.getAgentByXUserId("1"))!.x_verified).toBe(false);
  });

  it("updates the handle when the account was renamed, but not for a case difference", async () => {
    const s = await setup();
    const a = await registered(s.mesh, "1", "alice");
    x.me = { data: { id: "1", username: "ALICE" } };
    expect((await verify(s, a.verifyUrl)).status).toBe(200);
    expect(await s.mesh.store.getAgentByXUserId("1")).toMatchObject({ x_verified: true, x_handle: "alice" });

    x.me = { data: { id: "1", username: "alice_new" } };
    const again = await call(s.mesh, a.ctx, "start_x_verification");
    const c = await verify(s, again.body.verify_url);
    expect(c.status).toBe(200);
    expect(c.html).toContain("from @alice to @alice_new");
    expect(await s.mesh.store.getAgentByXUserId("1")).toMatchObject({ x_verified: true, x_handle: "alice_new" });
  });

  it("does not verify when the real handle is registered to a different agent", async () => {
    const s = await setup();
    const a = await registered(s.mesh, "1", "claimed_name");
    await registered(s.mesh, "2", "alice");
    const c = await verify(s, a.verifyUrl); // X says user 1 is @alice
    expect(c.status).toBe(409);
    expect(await s.mesh.store.getAgentByXUserId("1")).toMatchObject({ x_verified: false, x_handle: "claimed_name" });
  });

  it("handles a token endpoint error without echoing the provider's body", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    x.tokenStatus = 400;
    x.tokenBody = { error: "invalid_grant", error_description: "leaky-provider-detail", access_token: ACCESS_TOKEN };
    const c = await verify(s, a.verifyUrl);
    expect(c.status).toBe(502);
    expect(c.html).toContain("HTTP 400");
    expect(c.html).toContain("Nothing was changed");
    expect(c.html).not.toContain("leaky-provider-detail");
    expect(c.html).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("leaky-provider-detail");
    expect(x.calls.map((k) => k.url)).toEqual(["https://api.x.com/2/oauth2/token"]); // users/me never called
    expect((await s.mesh.store.getAgentByXUserId("1"))!.x_verified).toBe(false);
    // The link still works for another try within its lifetime.
    x.tokenStatus = 200;
    x.tokenBody = { access_token: ACCESS_TOKEN };
    expect((await verify(s, a.verifyUrl)).status).toBe(200);
  });

  it("handles a missing access token, a users/me error, a malformed user and a network failure", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    x.tokenBody = { token_type: "bearer" };
    expect((await verify(s, a.verifyUrl)).status).toBe(502);
    x.tokenBody = { access_token: ACCESS_TOKEN };
    x.meStatus = 401;
    const unauthorized = await verify(s, a.verifyUrl);
    expect(unauthorized.status).toBe(502);
    expect(unauthorized.html).toContain("HTTP 401");
    x.meStatus = 200;
    x.me = { data: { id: "1; drop", username: "alice" } };
    expect((await verify(s, a.verifyUrl)).status).toBe(502);
    x.me = { errors: [{ detail: "nope" }] };
    expect((await verify(s, a.verifyUrl)).status).toBe(502);

    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("http://127.0.0.1:")) return realFetch(input, init);
      throw new TypeError(`fetch failed while sending ${ACCESS_TOKEN}`);
    });
    const down = await verify(s, a.verifyUrl);
    expect(down.status).toBe(502);
    expect(down.html).toContain("Could not reach X");
    expect(down.html).not.toContain(ACCESS_TOKEN);
    expect((await s.mesh.store.getAgentByXUserId("1"))!.x_verified).toBe(false);
  });

  it("shows a provider error or a cancelled sign-in without calling X, escaping the error code", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const l = await login(s.local(a.verifyUrl));
    const denied = await callback(s.base, { error: "access_denied", state: l.authorize!.searchParams.get("state")! }, l.cookie);
    expect(denied.status).toBe(400);
    expect(denied.html).toContain("cancelled");
    const l2 = await login(s.local(a.verifyUrl));
    const odd = await callback(s.base, { error: `<script>alert(1)</script>`, state: l2.authorize!.searchParams.get("state")! }, l2.cookie);
    expect(odd.status).toBe(400);
    expect(odd.html).not.toContain("<script");
    const l3 = await login(s.local(a.verifyUrl));
    expect((await callback(s.base, { state: l3.authorize!.searchParams.get("state")! }, l3.cookie)).status).toBe(400); // no code
    expect(x.calls).toEqual([]);
  });

  it("escapes everything it interpolates into the page", async () => {
    const s = await setup();
    // Stored values that would be markup if written out raw (the tool schema would not let these in).
    const hostile = `<img src=x onerror="alert('1')">&`;
    await s.mesh.store.insertAgent({ x_user_id: "7", x_handle: hostile, agent_card_url: null, display_name: null, owner_opt_in: true, opted_in_at: null, api_key_hash: "h" });
    const agent = (await s.mesh.store.getAgentByXUserId("7"))!;
    const url = s.mesh.xauth.issueVerifyUrl(agent);
    x.me = { data: { id: "8", username: "bob" } };
    const c = await verify(s, url);
    expect(c.status).toBe(403);
    expect(c.html).not.toContain("<img");
    expect(c.html).not.toContain(`onerror="`);
    expect(c.html).toContain("&#60;img src=x onerror=&#34;alert(&#39;1&#39;)&#34;&#62;&#38;");

    // A username that is not a valid X handle never reaches the page at all.
    x.me = { data: { id: "7", username: `<script>alert(1)</script>` } };
    const bad = await verify(s, url);
    expect(bad.status).toBe(502);
    expect(bad.html).not.toContain("<script");
    expect((await s.mesh.store.getAgentByXUserId("7"))!.x_verified).toBe(false);
  });
});

describe("MESH_REQUIRE_VERIFIED with X OAuth", () => {
  it("works end to end once both agents have signed in with X", async () => {
    const s = await setup({ requireVerified: true });
    const alice = await registered(s.mesh, "1", "alice");
    const bob = await registered(s.mesh, "2", "bob");
    const lists = { follower_ids: ["2"], following_ids: ["2"] };

    // Nobody verified: alice sees no one and cannot propose.
    expect((await call(s.mesh, alice.ctx, "list_mutual_agents", lists)).body.agents).toEqual([]);
    const blocked = await call(s.mesh, alice.ctx, "propose_goal", { goal: "g", participant_x_user_ids: ["2"] });
    expect(blocked.body.error).toBe("forbidden");
    expect(blocked.body.message).toContain("start_x_verification");

    // Alice verifies: she may propose, but unverified bob is still hidden.
    expect((await verify(s, alice.verifyUrl)).status).toBe(200);
    expect((await call(s.mesh, alice.ctx, "list_mutual_agents", lists)).body.agents).toEqual([]);
    expect((await call(s.mesh, alice.ctx, "propose_goal", { goal: "g", participant_x_user_ids: ["2"] })).body.error).toBe("forbidden");

    // Bob verifies through start_x_verification.
    x.me = { data: { id: "2", username: "bob" } };
    const v = await call(s.mesh, bob.ctx, "start_x_verification");
    expect((await verify(s, v.body.verify_url)).status).toBe(200);

    const seen = await call(s.mesh, alice.ctx, "list_mutual_agents", lists);
    expect(seen.body.agents).toHaveLength(1);
    expect(seen.body.agents[0]).toMatchObject({ x_user_id: "2", x_handle: "bob", x_verified: true });
    expect(seen.body.agents[0].verification).toBeUndefined();
    const p = await call(s.mesh, alice.ctx, "propose_goal", { goal: "Plan the meetup", participant_x_user_ids: ["2"] });
    expect(p.isError).toBe(false);
    const accepted = await call(s.mesh, bob.ctx, "accept_goal", { thread_id: p.body.thread.thread_id, accept: true });
    expect(accepted.body.thread.status).toBe("active");

    // The per-agent card is served again, now marked verified.
    const card: any = await (await realFetch(`${s.base}/agents/bob/.well-known/agent-card.json`)).json();
    expect(card.description).toContain("X account verified");
  });

  it("keeps the invite-only registration gate: no key, ticket or verification without the invite token", async () => {
    const s = await setup({ adminToken: "invite-token" });
    const refused = await call(s.mesh, { ip: "a" }, "register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true });
    expect(refused.body.error).toBe("forbidden");
    expect(refused.body.verify_url).toBeUndefined();
    expect((s.mesh.xauth as any).tickets.size).toBe(0);
    // Signing in with X alone (whoami) creates nothing.
    const l = await login(`${s.base}/auth/x/login`);
    expect((await callback(s.base, { code: "c", state: l.authorize!.searchParams.get("state")! }, l.cookie)).status).toBe(200);
    expect(await s.mesh.store.getAgentByXUserId("1")).toBeNull();
    const ok = await call(s.mesh, { ip: "a" }, "register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true, admin_token: "invite-token" });
    expect(ok.body.verify_url).toContain("/auth/x/login?ticket=");
  });

  it("key rotation keeps a verified agent verified; changing the handle un-verifies it", async () => {
    const s = await setup();
    const a = await registered(s.mesh, "1", "alice");
    expect((await verify(s, a.verifyUrl)).status).toBe(200);
    const rotated = await call(s.mesh, a.ctx, "register_agent", { x_user_id: "1", x_handle: "Alice", owner_opt_in: true });
    expect(rotated.body).toMatchObject({ rotated: true, x_verified: true });
    expect(rotated.body.verify_url).toBeUndefined();
    const renamed = await call(s.mesh, { ip: "a", apiKey: rotated.body.api_key }, "register_agent", { x_user_id: "1", x_handle: "someone_else", owner_opt_in: true });
    expect(renamed.body).toMatchObject({ rotated: true, x_verified: false, x_handle: "someone_else" });
    expect(renamed.body.verify_url).toContain("/auth/x/login?ticket=");
    expect((await s.mesh.store.getAgentByXUserId("1"))!.x_verified).toBe(false);
  });
});
