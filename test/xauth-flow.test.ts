// Sign in with X, end to end over real HTTP against a fake X (test/http-helpers.ts: no real network
// or credentials). test/xauth.test.ts covers the basic flow; this file is about what an attacker or
// a broken provider can do to it: state / PKCE / cookie binding, callback validation, races, error
// paths, redirects, and the bounds on what the server keeps in memory.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeshConfig } from "../src/config.js";
import type { Mesh } from "../src/mesh.js";
import type { Agent } from "../src/store.js";
import { STATE_TTL_MS, TICKET_TTL_MS, X_AUTHORIZE_URL } from "../src/xauth.js";
import { call, newMesh } from "./helpers.js";
import { ACCESS_TOKEN, callback, CLIENT_ID, CLIENT_SECRET, closeServers, fakeX, login, realFetch, serve, xOAuth, type FakeX } from "./http-helpers.js";

let x: FakeX;
let errors: ReturnType<typeof vi.spyOn>;
/** Every page and Location header the tests saw. */
let seen: string[];

beforeEach(() => {
  x = fakeX();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  seen = [];
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeServers();
  // Neither the client secret nor an X token may reach a log line, a page or a redirect.
  const out = `${JSON.stringify(errors.mock.calls.map((c: unknown[]) => c.map(String)))}\n${seen.join("\n")}`;
  for (const secret of [CLIENT_SECRET, ACCESS_TOKEN]) expect(out).not.toContain(secret);
  errors.mockRestore();
});

async function setup(over: Partial<MeshConfig> = {}, now?: () => number) {
  const mesh = newMesh({ xOAuth, ...over }, now);
  const base = await serve(mesh);
  const local = (verifyUrl: string) => verifyUrl.replace("https://mesh.test", base);
  const start = async (url: string, headers: Record<string, string> = {}) => {
    const l = await login(url.startsWith("http://127.0.0.1") ? url : local(url), headers);
    seen.push(l.location ?? "", l.setCookie);
    return l;
  };
  const finish = async (params: Record<string, string>, cookie?: string) => {
    const c = await callback(base, params, cookie);
    seen.push(c.html, c.res.headers.get("location") ?? "");
    return c;
  };
  return { mesh, base, local, start, finish };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function registered(mesh: Mesh, id = "1", handle = "alice") {
  const r = await call(mesh, { ip: `ip-${id}` }, "register_agent", { x_user_id: id, x_handle: handle, owner_opt_in: true });
  expect(r.isError).toBe(false);
  return { id, key: r.body.api_key as string, ctx: { apiKey: r.body.api_key as string, ip: `ip-${id}` }, verifyUrl: r.body.verify_url as string };
}

const verified = async (s: Setup, id = "1") => (await s.mesh.store.getAgentByXUserId(id))?.x_verified;
const pendingOf = (mesh: Mesh) => (mesh.xauth as any).pending as Map<string, { verifier: string; cookieHash: string; expires: number; bound?: unknown }>;
const ticketsOf = (mesh: Mesh) => (mesh.xauth as any).tickets as Map<string, unknown>;
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
const tokenCalls = () => x.calls.filter((c) => c.url.endsWith("/oauth2/token"));

describe("state, PKCE and the browser cookie", () => {
  it("every sign-in gets its own state, verifier, challenge and cookie", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const logins = [];
    for (let i = 0; i < 8; i++) logins.push(await s.start(i % 2 ? a.verifyUrl : `${s.base}/auth/x/login`));
    for (const field of ["state", "cookie"] as const) expect(new Set(logins.map((l) => l[field])).size).toBe(8);
    const challenges = logins.map((l) => l.authorize!.searchParams.get("code_challenge"));
    expect(new Set(challenges).size).toBe(8);
    const pending = [...pendingOf(s.mesh).values()];
    expect(new Set(pending.map((p) => p.verifier)).size).toBe(8);
    expect(pending.map((p) => s256(p.verifier)).sort()).toEqual([...challenges].sort());
    // What the server keeps is hashes: neither a state nor a cookie value is stored as is.
    const kept = JSON.stringify([...pendingOf(s.mesh).entries()]);
    for (const l of logins) {
      expect(kept).not.toContain(l.state);
      expect(kept).not.toContain(l.cookie.split("=")[1]);
      // And the redirect gives X the challenge, never the verifier, the cookie or the ticket.
      for (const p of pending) expect(l.location).not.toContain(p.verifier);
      expect(l.location).not.toContain(l.cookie.split("=")[1]);
    }
  });

  it("sends X the verifier of the sign-in being finished, not of another one in flight", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const first = await s.start(a.verifyUrl);
    const second = await s.start(`${s.base}/auth/x/login`);
    const third = await s.start(a.verifyUrl);
    // Finished out of order: the who-am-I one, then the later of the two started from the link.
    for (const l of [second, third]) {
      x.calls.length = 0;
      expect((await s.finish({ code: `code-for-${l.state.slice(0, 6)}`, state: l.state }, l.cookie)).status).toBe(200);
      const form = new URLSearchParams(tokenCalls()[0]!.init.body as string);
      expect(s256(form.get("code_verifier")!)).toBe(l.authorize!.searchParams.get("code_challenge"));
      expect(form.get("code")).toBe(`code-for-${l.state.slice(0, 6)}`);
      expect(form.get("redirect_uri")).toBe(l.authorize!.searchParams.get("redirect_uri"));
    }
    expect(await verified(s)).toBe(true);
    // The link is spent now, so the other sign-in started from it ends without its code reaching X.
    x.calls.length = 0;
    expect((await s.finish({ code: "late", state: first.state }, first.cookie)).status).toBe(400);
    expect(x.calls).toEqual([]);
  });

  it("a state only works with the cookie set by the same login response", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const victim = await s.start(a.verifyUrl);
    const attacker = await s.start(a.verifyUrl);
    const whoami = await s.start(`${s.base}/auth/x/login`);
    const wrong = [
      attacker.cookie, // the attacker's own cookie with the victim's state (and the reverse, below)
      whoami.cookie,
      `xam_oauth=${victim.state}`, // the state is not the cookie
      `xam_oauth=${createHash("sha256").update(victim.cookie.split("=")[1]!).digest("hex")}`, // nor is the stored hash
      `xam_oauth=${victim.cookie.split("=")[1]!.slice(0, -1)}`,
      `xam_oauth=${victim.cookie.split("=")[1]!}x`,
      `XAM_OAUTH=${victim.cookie.split("=")[1]!}`, // cookie names are case-sensitive
      `xam_oauth=wrong; ${victim.cookie}`, // the first cookie of that name counts
      `xam_oauth2=${victim.cookie.split("=")[1]!}`,
      "",
    ];
    for (const cookie of wrong) {
      const c = await s.finish({ code: "c", state: victim.state }, cookie || undefined);
      expect(c.status, cookie.slice(0, 30)).toBe(400);
      expect(c.html).toContain("not started in this browser");
      expect(c.res.headers.get("set-cookie")).toBeNull(); // the real browser's cookie is left alone
    }
    expect((await s.finish({ code: "c", state: attacker.state }, victim.cookie)).status).toBe(400);
    expect(x.calls).toEqual([]);
    expect(await verified(s)).toBe(false);
    // None of that used up the victim's state: the right browser still finishes.
    expect((await s.finish({ code: "c", state: victim.state }, `theme=dark; ${victim.cookie}; other=1`)).status).toBe(200);
    expect(await verified(s)).toBe(true);
  });

  it("a state is single-use even when two callbacks race", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const l = await s.start(a.verifyUrl);
    // Hold the token endpoint open so both callbacks are in flight together.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    x.respond = async (url) => {
      if (url.endsWith("/oauth2/token")) await gate;
      return undefined;
    };
    const both = [s.finish({ code: "c", state: l.state }, l.cookie), s.finish({ code: "c", state: l.state }, l.cookie)];
    await new Promise((r) => setTimeout(r, 50));
    release();
    const statuses = (await Promise.all(both)).map((c) => c.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(tokenCalls()).toHaveLength(1); // the authorization code was sent to X once
    expect(pendingOf(s.mesh).size).toBe(0);
  });

  it("a state stops working after 10 minutes, a ticket after 15, and the clock is the server's", async () => {
    let t = 1_800_000_000_000;
    const s = await setup({}, () => t);
    const a = await registered(s.mesh);
    const l = await s.start(a.verifyUrl);
    t += STATE_TTL_MS; // exactly at the limit is still in time
    expect((await s.finish({ code: "c", state: l.state }, l.cookie)).status).toBe(200);

    const b = await call(s.mesh, a.ctx, "start_x_verification");
    const l2 = await s.start(b.body.verify_url);
    t += STATE_TTL_MS + 1;
    const late = await s.finish({ code: "c", state: l2.state }, l2.cookie);
    expect(late.status).toBe(400);
    expect(pendingOf(s.mesh).size).toBe(0); // the expired sign-in was dropped
    // A sign-in started in the ticket's last second may still finish within its own 10 minutes.
    t += TICKET_TTL_MS - STATE_TTL_MS - 2000;
    const l3 = await s.start(b.body.verify_url);
    expect(l3.status).toBe(302);
    t += STATE_TTL_MS - 1000;
    expect((await s.start(b.body.verify_url)).status).toBe(400); // the link itself has expired by now
    expect((await s.finish({ code: "c", state: l3.state }, l3.cookie)).status).toBe(200);
  });
});

describe("callback validation", () => {
  it("never calls X, changes nothing and never fails with a 500 for a malformed callback", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const l = await s.start(a.verifyUrl);
    const long = "A".repeat(6000);
    const queries = [
      "",
      "code=c",
      "state=",
      `state=${l.state.slice(0, -1)}`,
      `state=${l.state}x`,
      `state=${l.state.toUpperCase()}`,
      `state=other&state=${l.state}`, // only the first value counts
      `state[]=${l.state}`,
      `STATE=${l.state}`,
      `state=${long}&code=${long}`,
      `state=%00%0d%0a&code=%00`,
      `state=${encodeURIComponent("<script>alert(1)</script>")}&code=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`,
      `error=${encodeURIComponent("<script>alert(1)</script>")}&error_description=${encodeURIComponent("<b>hi</b>")}`,
      "code=c&state=__proto__",
      "code=c&state=constructor",
    ];
    for (const q of queries) {
      const res = await realFetch(`${s.base}/auth/x/callback?${q}`, { headers: { Cookie: l.cookie }, redirect: "manual" });
      const html = await res.text();
      seen.push(html);
      expect(res.status, q.slice(0, 40)).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(html).not.toMatch(/<script|<img|<b>/);
      expect(html).not.toContain(long);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
    expect(x.calls).toEqual([]);
    expect(await verified(s)).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    // The real sign-in is still there.
    expect((await s.finish({ code: "c", state: l.state }, l.cookie)).status).toBe(200);
  });

  it("an error from X wins over a code, uses up the state, and is shown without its text", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const l = await s.start(a.verifyUrl);
    const c = await s.finish({ error: "server_error", error_description: "leaky <b>description</b>", error_uri: "https://evil.example/", code: "c", state: l.state }, l.cookie);
    expect(c.status).toBe(400);
    expect(c.html).toContain("X reported an error (server_error)");
    expect(c.html).not.toContain("leaky");
    expect(c.html).not.toContain("evil.example");
    expect(x.calls).toEqual([]);
    expect((await s.finish({ code: "c", state: l.state }, l.cookie)).status).toBe(400); // spent
    expect(await verified(s)).toBe(false);
    // The ticket is not spent by a failed attempt.
    const again = await s.start(a.verifyUrl);
    expect((await s.finish({ code: "c", state: again.state }, again.cookie)).status).toBe(200);
  });

  it("does not verify through a link that was replaced, or for an agent that has gone", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const stale = await s.start(a.verifyUrl);
    const fresh = await call(s.mesh, a.ctx, "start_x_verification"); // replaces the ticket mid-flow
    const c = await s.finish({ code: "c", state: stale.state }, stale.cookie);
    expect(c.status).toBe(400);
    expect(c.html).toContain("already used or replaced");
    expect(x.calls).toEqual([]); // the code was never sent to X
    expect(await verified(s)).toBe(false);

    // The agent's row disappears (an operator removed it) between login and callback.
    const l = await s.start(fresh.body.verify_url);
    vi.spyOn(s.mesh.store, "getAgentByXUserId").mockResolvedValueOnce(null);
    const gone = await s.finish({ code: "c", state: l.state }, l.cookie);
    expect(gone.status).toBe(404);
    expect(gone.html).toContain("no longer exists");

    // The X user id was re-registered as a different agent row in between: the old link is not for it.
    const l2 = await s.start(fresh.body.verify_url);
    const row = (await s.mesh.store.getAgentByXUserId("1")) as Agent;
    vi.spyOn(s.mesh.store, "getAgentByXUserId").mockResolvedValueOnce({ ...row, id: "00000000-0000-4000-8000-00000000beef" });
    expect((await s.finish({ code: "c", state: l2.state }, l2.cookie)).status).toBe(404);
    expect(await verified(s)).toBe(false);
  });

  it("key rotation between login and callback does not break or bypass verification", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const l = await s.start(a.verifyUrl);
    const rotated = await call(s.mesh, a.ctx, "register_agent", { x_user_id: "1", x_handle: "alice", owner_opt_in: true });
    expect(rotated.body.rotated).toBe(true);
    // Rotation issued a new link, which replaced the one this sign-in started from.
    expect((await s.finish({ code: "c", state: l.state }, l.cookie)).status).toBe(400);
    const l2 = await s.start(rotated.body.verify_url);
    expect((await s.finish({ code: "c", state: l2.state }, l2.cookie)).status).toBe(200);
    expect(await verified(s)).toBe(true);
  });

  it("who-am-I sign-ins never verify anyone, whoever signs in", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    for (const me of [{ id: "1", username: "alice" }, { id: "2", username: "bob" }]) {
      x.me = { data: me };
      const l = await s.start(`${s.base}/auth/x/login`);
      const c = await s.finish({ code: "c", state: l.state }, l.cookie);
      expect(c.status).toBe(200);
      expect(c.html).toContain(`@${me.username} (X user id ${me.id})`);
      expect(c.html).toContain("No agent was changed");
    }
    expect(await verified(s)).toBe(false);
    expect(ticketsOf(s.mesh).size).toBe(1); // alice's link is untouched
    // A ticket parameter that is present but empty is a bad link, not a who-am-I sign-in.
    expect((await s.start(`${s.base}/auth/x/login?ticket=`)).status).toBe(400);
    expect((await s.start(`${s.base}/auth/x/login?ticket=wrong&ticket=${new URL(a.verifyUrl).searchParams.get("ticket")}`)).status).toBe(400);
  });
});

describe("what X answers", () => {
  const html = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/html" } });

  it("treats any unexpected answer from the token or users/me endpoint as a failed sign-in", async () => {
    const s = await setup({ trustProxy: "fly" });
    const a = await registered(s.mesh);
    let n = 0;
    const attempt = async () => {
      // A new address each time: sign-in starts are limited to 20 per address.
      const l = await s.start(a.verifyUrl, { "Fly-Client-IP": `10.0.0.${++n}` });
      expect(l.status).toBe(302);
      return s.finish({ code: "c", state: l.state }, l.cookie);
    };
    const leak = "provider-internal-detail-<b>";
    const tokenAnswers: (() => Response)[] = [
      () => html(200, `<html>${leak}</html>`), // not JSON
      () => new Response("", { status: 200 }),
      () => Response.json(null),
      () => Response.json([{ access_token: ACCESS_TOKEN }]),
      () => Response.json(`"${leak}"`),
      () => Response.json({ access_token: 12345 }),
      () => Response.json({ access_token: "" }),
      () => Response.json({ access_token: { value: ACCESS_TOKEN } }),
      () => Response.json({ error: "invalid_request", error_description: leak }, { status: 400 }),
      () => Response.json({ error: leak }, { status: 401 }),
      () => html(500, leak),
      () => html(503, leak),
    ];
    for (const [i, answer] of tokenAnswers.entries()) {
      x.calls.length = 0;
      x.respond = (url) => (url.endsWith("/oauth2/token") ? answer() : undefined);
      const c = await attempt();
      expect(c.status, `token answer ${i}`).toBe(502);
      expect(c.html).toContain("Nothing was changed");
      expect(c.html).not.toContain("provider-internal-detail");
      expect(x.calls.map((k) => k.url), `token answer ${i}`).toEqual(["https://api.x.com/2/oauth2/token"]); // users/me never asked
    }
    const meAnswers: (() => Response)[] = [
      () => html(200, leak),
      () => Response.json(null),
      () => Response.json({ data: null }),
      () => Response.json({ data: [] }),
      () => Response.json({ data: { id: 1, username: "alice" } }), // a number is not an id string
      () => Response.json({ data: { id: "1" } }),
      () => Response.json({ data: { username: "alice" } }),
      () => Response.json({ data: { id: "1", username: "" } }),
      () => Response.json({ data: { id: "1", username: "a".repeat(16) } }),
      () => Response.json({ data: { id: "01x", username: "alice" } }),
      () => Response.json({ data: { id: " 1", username: "alice" } }),
      () => Response.json({ data: { id: "1", username: "alice\n" } }),
      () => Response.json({ data: { id: "1".repeat(21), username: "alice" } }),
      () => Response.json({ id: "1", username: "alice" }), // not under data
      () => Response.json({ errors: [{ detail: leak }] }, { status: 403 }),
      () => html(429, leak),
    ];
    for (const [i, answer] of meAnswers.entries()) {
      x.respond = (url) => (url.endsWith("/users/me") ? answer() : undefined);
      const c = await attempt();
      expect(c.status, `users/me answer ${i}`).toBe(502);
      expect(c.html).not.toContain("provider-internal-detail");
    }
    expect(await verified(s)).toBe(false);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("provider-internal-detail");
    // After all those failures the same link still verifies once X behaves.
    x.respond = undefined;
    expect((await attempt()).status).toBe(200);
    expect(await verified(s)).toBe(true);
  });

  it("does not follow redirects from X, bounds how long it waits, and survives a timeout", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const l = await s.start(a.verifyUrl);
    expect((await s.finish({ code: "c", state: l.state }, l.cookie)).status).toBe(200);
    expect(x.calls).toHaveLength(2);
    for (const k of x.calls) {
      expect(k.init.redirect).toBe("error"); // a redirect would carry the secret or the token elsewhere
      expect(k.init.signal).toBeInstanceOf(AbortSignal);
      expect(new URL(k.url).origin).toBe("https://api.x.com");
    }

    const b = await registered(s.mesh, "2", "bob");
    for (const failing of ["/oauth2/token", "/users/me"]) {
      x.respond = (url) => {
        if (!url.endsWith(failing)) return undefined;
        throw Object.assign(new Error(`The operation timed out while sending ${CLIENT_SECRET} ${ACCESS_TOKEN}`), { name: "TimeoutError" });
      };
      const l2 = await s.start(b.verifyUrl);
      const c = await s.finish({ code: "c", state: l2.state }, l2.cookie);
      expect(c.status).toBe(502);
      expect(c.html).toContain("Could not reach X");
    }
    expect(await verified(s, "2")).toBe(false);
    // Only the error's name was logged, never its message.
    expect(errors.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(["[x-agent-mesh] X OAuth callback failed: TimeoutError", "[x-agent-mesh] X OAuth callback failed: TimeoutError"]);
  });

  it("a store failure while verifying is reported as a failed sign-in, without the detail", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const l = await s.start(a.verifyUrl);
    vi.spyOn(s.mesh.store, "updateAgent").mockRejectedValueOnce(new Error("disk I/O error at /data/mesh.db"));
    const c = await s.finish({ code: "c", state: l.state }, l.cookie);
    expect(c.status).toBe(502);
    expect(c.html).not.toContain("/data/mesh.db");
    expect(await verified(s)).toBe(false);
    const again = await s.start(a.verifyUrl); // the ticket was not spent
    expect((await s.finish({ code: "c", state: again.state }, again.cookie)).status).toBe(200);
  });
});

describe("redirects, cookies and headers", () => {
  it("only ever redirects to X's authorize URL, whatever the query asks for", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const extras = "&redirect_uri=https://evil.example/cb&return_to=https://evil.example&next=//evil.example&client_id=evil&scope=offline.access+tweet.write&state=chosen&code_challenge=chosen&code_challenge_method=plain&response_type=token";
    for (const url of [`${s.local(a.verifyUrl)}${extras}`, `${s.base}/auth/x/login?x=1${extras}`, `${s.base}/auth/x/login/?${extras.slice(1)}`]) {
      const l = await s.start(url, { Host: "evil.example", "X-Forwarded-Host": "evil.example", Referer: "https://evil.example/" });
      expect(l.status).toBe(302);
      expect(l.location!.startsWith(`${X_AUTHORIZE_URL}?`)).toBe(true);
      expect(l.location).not.toContain("evil");
      const q = l.authorize!.searchParams;
      expect([...q.keys()].sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"]);
      expect(Object.fromEntries(q)).toMatchObject({ client_id: CLIENT_ID, redirect_uri: "https://mesh.test/auth/x/callback", scope: "users.read tweet.read", code_challenge_method: "S256", response_type: "code" });
      expect(q.get("state")).not.toBe("chosen");
      expect(q.get("code_challenge")).not.toBe("chosen");
    }
    // The callback never redirects at all, on success or failure.
    const l = await s.start(a.verifyUrl);
    const attempts: Record<string, string>[] = [{ code: "c", state: "nope", redirect_uri: "https://evil.example" }, { code: "c", state: l.state, return_to: "https://evil.example", next: "//evil.example" }];
    for (const params of attempts) {
      const res = await realFetch(`${s.base}/auth/x/callback?${new URLSearchParams(params)}`, { headers: { Cookie: l.cookie }, redirect: "manual" });
      expect([200, 400]).toContain(res.status);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).not.toContain("evil.example");
    }
  });

  it("sets a short-lived, HttpOnly, SameSite=Lax, Secure cookie scoped to /auth/x, and clears it when the sign-in ends", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const b = await registered(s.mesh, "2", "bob");
    const attrs = (setCookie: string) => setCookie.split(";").slice(1).map((p) => p.trim()).sort();
    const l = await s.start(a.verifyUrl);
    expect(attrs(l.setCookie)).toEqual(["HttpOnly", `Max-Age=${STATE_TTL_MS / 1000}`, "Path=/auth/x", "SameSite=Lax", "Secure"]);
    expect(l.setCookie).not.toMatch(/Domain=/i); // host-only
    expect(l.res.headers.get("referrer-policy")).toBe("no-referrer"); // the ticket in the URL is not sent on to X
    expect(l.res.headers.get("cache-control")).toBe("no-store");
    expect(l.res.headers.get("strict-transport-security")).toBe("max-age=31536000");

    const cleared = "xam_oauth=; Path=/auth/x; Max-Age=0; HttpOnly; SameSite=Lax; Secure";
    const ok = await s.finish({ code: "c", state: l.state }, l.cookie);
    expect(ok.res.headers.get("set-cookie")).toBe(cleared);
    // Wrong account (403) and who-am-I (200) end the sign-in too.
    x.me = { data: { id: "9", username: "mallory" } };
    const l2 = await s.start(b.verifyUrl);
    const wrong = await s.finish({ code: "c", state: l2.state }, l2.cookie);
    expect(wrong.status).toBe(403);
    expect(wrong.res.headers.get("set-cookie")).toBe(cleared);
    const l3 = await s.start(`${s.base}/auth/x/login`);
    expect((await s.finish({ code: "c", state: l3.state }, l3.cookie)).res.headers.get("set-cookie")).toBe(cleared);

    for (const page of [ok, wrong]) {
      const h = page.res.headers;
      expect(h.get("content-type")).toBe("text/html; charset=utf-8");
      expect(h.get("cache-control")).toBe("no-store");
      expect(h.get("x-frame-options")).toBe("DENY");
      expect(h.get("x-content-type-options")).toBe("nosniff");
      expect(h.get("referrer-policy")).toBe("no-referrer");
      expect(h.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      expect(h.get("strict-transport-security")).toBe("max-age=31536000");
      expect(page.html).not.toMatch(/<script|<a |<form|<iframe|javascript:/i);
    }
  });

  it("the pages never contain a ticket, a state, a cookie value, a key or the client id", async () => {
    const s = await setup();
    const a = await registered(s.mesh);
    const ticket = new URL(a.verifyUrl).searchParams.get("ticket")!;
    const l = await s.start(a.verifyUrl);
    const pages = [
      await s.finish({ code: "c", state: l.state }, "xam_oauth=wrong"),
      await s.finish({ code: "c", state: "unknown" }, l.cookie),
      await s.finish({ code: "c", state: l.state }, l.cookie),
      await s.finish({ code: "c", state: l.state }, l.cookie),
    ];
    const bad = await realFetch(`${s.base}/auth/x/login?ticket=${ticket}x`);
    const all = `${pages.map((p) => p.html).join("\n")}\n${await bad.text()}`;
    for (const secret of [ticket, l.state, l.cookie.split("=")[1]!, a.key, CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN]) expect(all).not.toContain(secret);
  });
});

describe("limits on sign-in starts and on what is kept in memory", () => {
  it("limits sign-in starts per address with a 429 page, without creating a pending sign-in", async () => {
    let t = 1_800_000_000_000;
    const s = await setup({ trustProxy: "fly" }, () => t);
    const from = (ip: string) => ({ "Fly-Client-IP": ip });
    for (let i = 0; i < 20; i++) expect((await s.start(`${s.base}/auth/x/login`, from("1.1.1.1"))).status).toBe(302);
    const limited = await s.start(`${s.base}/auth/x/login`, from("1.1.1.1"));
    expect(limited.status).toBe(429);
    expect(limited.res.headers.get("retry-after")).toBe("5");
    expect(limited.location).toBeNull();
    expect(limited.setCookie).toBe("");
    expect(await limited.res.text()).toContain("Too many sign-in attempts");
    expect(pendingOf(s.mesh).size).toBe(20);
    // Per address, and it refills.
    expect((await s.start(`${s.base}/auth/x/login`, from("2.2.2.2"))).status).toBe(302);
    t += 5000;
    expect((await s.start(`${s.base}/auth/x/login`, from("1.1.1.1"))).status).toBe(302);
    // A bad ticket costs a token as well: tickets cannot be guessed for free.
    for (let i = 0; i < 25; i++) await s.start(`${s.base}/auth/x/login?ticket=guess-${i}`, from("3.3.3.3"));
    expect((await s.start(`${s.base}/auth/x/login?ticket=guess`, from("3.3.3.3"))).status).toBe(429);
  });

  it("keeps at most 2000 pending sign-ins; a flood of who-am-I starts cannot push out an owner mid-verification", async () => {
    let t = 1_800_000_000_000;
    const mesh = newMesh({ xOAuth }, () => t);
    const base = await serve(mesh);
    const a = await registered(mesh);
    const owner = await login(a.verifyUrl.replace("https://mesh.test", base));
    expect(owner.status).toBe(302);
    // 5000 anonymous starts from 5000 addresses (straight into the handler: the HTTP path is the same code).
    for (let i = 0; i < 5000; i++) {
      expect(mesh.xauth.login(new URLSearchParams(), `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`).status).toBe(302);
      expect(pendingOf(mesh).size).toBeLessThanOrEqual(2000);
    }
    expect(pendingOf(mesh).size).toBe(2000);
    expect([...pendingOf(mesh).values()].filter((p) => p.bound)).toHaveLength(1);
    expect((await callback(base, { code: "c", state: owner.state }, owner.cookie)).status).toBe(200);
    expect((await mesh.store.getAgentByXUserId("1"))!.x_verified).toBe(true);

    // Expired sign-ins are swept before anything live is dropped.
    mesh.xauth.login(new URLSearchParams(), "10.9.9.8"); // back to 2000
    expect(pendingOf(mesh).size).toBe(2000);
    t += STATE_TTL_MS + 1;
    mesh.xauth.login(new URLSearchParams(), "10.9.9.9");
    expect(pendingOf(mesh).size).toBe(1);
  });

  it("when every pending sign-in belongs to a verify link, the oldest gives way", async () => {
    const mesh = newMesh({ xOAuth });
    const a = await registered(mesh);
    const ticket = new URLSearchParams({ ticket: new URL(a.verifyUrl).searchParams.get("ticket")! });
    const states: string[] = [];
    for (let i = 0; i < 2003; i++) {
      const out = mesh.xauth.login(ticket, `10.1.${(i >> 8) & 255}.${i & 255}`);
      states.push(new URL(out.headers.Location!).searchParams.get("state")!);
    }
    const kept = pendingOf(mesh);
    expect(kept.size).toBe(2000);
    const has = (state: string) => kept.has(createHash("sha256").update(state).digest("hex"));
    expect(states.slice(0, 3).map(has)).toEqual([false, false, false]);
    expect(has(states[3]!)).toBe(true);
    expect(has(states.at(-1)!)).toBe(true);
  });

  it("keeps one live verify link per agent and at most 10,000 in all", async () => {
    let t = 1_800_000_000_000;
    const mesh = newMesh({ xOAuth }, () => t);
    const agent = (i: number): Agent => ({ id: `agent-${i}`, x_user_id: String(i), x_handle: `h${i}`, agent_card_url: null, display_name: null, owner_opt_in: true, opted_in_at: null, x_verified: false, api_key_hash: null, stored_bytes: 0, created_at: "", updated_at: "" });
    for (let i = 0; i < 50; i++) mesh.xauth.issueVerifyUrl(agent(1)); // re-issuing replaces
    expect(ticketsOf(mesh).size).toBe(1);
    const first = mesh.xauth.issueVerifyUrl(agent(2));
    for (let i = 3; i < 10_050; i++) {
      mesh.xauth.issueVerifyUrl(agent(i));
      expect(ticketsOf(mesh).size).toBeLessThanOrEqual(10_000);
    }
    expect(ticketsOf(mesh).size).toBe(10_000);
    expect(((mesh.xauth as any).ticketOf as Map<string, string>).size).toBe(10_000);
    // The oldest links were dropped and no longer start a sign-in.
    expect(mesh.xauth.login(new URL(first).searchParams, "10.0.0.1").status).toBe(400);
    // Long-expired links are swept before live ones are dropped.
    t += TICKET_TTL_MS + STATE_TTL_MS + 1;
    const live = mesh.xauth.issueVerifyUrl(agent(99_999));
    expect(ticketsOf(mesh).size).toBe(1);
    expect(mesh.xauth.login(new URL(live).searchParams, "10.0.0.2").status).toBe(302);
  });
});
