// X identity proof: "Sign in with X" (OAuth 2.0 Authorization Code + PKCE S256, confidential client).
//
// What is proven: the person who opens an agent's verify_url (handed out only to the holder of the
// agent's API key, by register_agent / start_x_verification) can sign in to X as the account whose
// id the agent registered. Only then is `x_verified` set.
//
//   1. issueVerifyUrl(agent): a random one-time ticket bound to the agent, valid 15 minutes. Only
//      its SHA-256 hash is kept. A new ticket replaces the agent's previous one.
//   2. GET /auth/x/login?ticket=...: creates a PKCE verifier, a `state` and a browser-binding
//      cookie, keeps {state -> verifier, agent, cookie hash} for 10 minutes, redirects to X.
//      Without a ticket it runs in "whoami" mode: the callback only shows who signed in.
//   3. GET /auth/x/callback: checks state and cookie, exchanges the code, calls /2/users/me.
//      `data.id` must equal the agent's `x_user_id`; then x_verified = true (and the handle is
//      updated if the account was renamed) and the ticket is spent.
//
// The X tokens live in local variables for the length of one request and are never stored or
// logged; no refresh token is requested. This file is the only place the server talks to X, and it
// only reads the signed-in user's own id and username.
//
// Tickets and pending sign-ins are in process memory (single instance): a restart drops them, and
// the owner simply asks for a new verify_url.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { xOAuthConfigured, type MeshConfig } from "./config.js";
import { RateLimiter } from "./ratelimit.js";
import type { Agent, Store } from "./store.js";

/** Shown wherever an unverified agent is returned. */
export const UNVERIFIED_NOTE =
  "UNVERIFIED: this agent has not yet proven control of this X account via Sign in with X; its owner should open the verify_url from register_agent or start_x_verification. Tell your owner before relying on who it claims to be.";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_ME_URL = "https://api.x.com/2/users/me";

export const TICKET_TTL_MS = 15 * 60_000;
export const STATE_TTL_MS = 10 * 60_000;
const MAX_TICKETS = 10_000;
const MAX_PENDING = 2_000;
const FETCH_TIMEOUT_MS = 10_000;
const COOKIE = "xam_oauth";
const COOKIE_PATH = "/auth/x";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url"); // 43 characters, 256 bits
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** What an /auth/x/* route answers: http.ts writes it out as is. */
export interface AuthResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Ticket {
  agentId: string;
  xUserId: string;
  expires: number;
}

interface Pending {
  verifier: string;
  cookieHash: string;
  expires: number;
  /** Absent in whoami mode. */
  bound?: { ticketHash: string; agentId: string; xUserId: string };
}

/** A failure the owner is shown. `message` is our own text: never a provider response body. */
class AuthFailure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class XAuth {
  /** Ticket hash → ticket. */
  private tickets = new Map<string, Ticket>();
  /** Agent id → the hash of its current ticket (one live ticket per agent). */
  private ticketOf = new Map<string, string>();
  /** State hash → pending sign-in. */
  private pending = new Map<string, Pending>();
  /** /auth/x/login needs no key, so it is limited per IP. */
  private loginLimiter: RateLimiter;

  constructor(
    private store: Store,
    private cfg: MeshConfig,
    private now: () => number = Date.now,
  ) {
    this.loginLimiter = new RateLimiter({ capacity: 20, refillPerSec: 0.2 }, now);
  }

  get configured(): boolean {
    return xOAuthConfigured(this.cfg);
  }

  // ---- tickets ----

  /** A fresh verify_url for `agent`, replacing any earlier one. Call only for the authenticated holder of the agent's key. */
  issueVerifyUrl(agent: Agent): string {
    const t = this.now();
    const previous = this.ticketOf.get(agent.id);
    if (previous) this.tickets.delete(previous);
    if (this.tickets.size >= MAX_TICKETS) {
      // A ticket stays until its last possible sign-in has expired (see `ticket`).
      for (const [h, k] of this.tickets) if (t > k.expires + STATE_TTL_MS) this.dropTicket(h);
      if (this.tickets.size >= MAX_TICKETS) this.dropTicket(this.tickets.keys().next().value as string);
    }
    const ticket = token();
    const hash = sha256(ticket);
    this.tickets.set(hash, { agentId: agent.id, xUserId: agent.x_user_id, expires: t + TICKET_TTL_MS });
    this.ticketOf.set(agent.id, hash);
    return `${this.cfg.publicUrl}/auth/x/login?ticket=${ticket}`;
  }

  private dropTicket(hash: string) {
    const k = this.tickets.get(hash);
    this.tickets.delete(hash);
    if (k && this.ticketOf.get(k.agentId) === hash) this.ticketOf.delete(k.agentId);
  }

  // ---- routes ----

  /** GET /auth/x/login[?ticket=...] */
  login(query: URLSearchParams, ip: string): AuthResponse {
    const off = this.unavailable();
    if (off) return off;
    const wait = this.loginLimiter.take(ip);
    if (wait > 0) return page(429, "Too many sign-in attempts", [`Wait ${wait} seconds and try again.`], { "Retry-After": String(wait) });

    const t = this.now();
    let bound: Pending["bound"];
    if (query.has("ticket")) {
      const ticketHash = sha256(query.get("ticket") ?? "");
      const k = this.tickets.get(ticketHash);
      if (!k || t > k.expires) {
        return page(400, "This verification link is not valid", [
          "It has expired (links last 15 minutes), was already used, or was replaced by a newer one.",
          "Ask your agent to call start_x_verification for a fresh verify_url.",
        ]);
      }
      bound = { ticketHash, agentId: k.agentId, xUserId: k.xUserId };
    }

    if (this.pending.size >= MAX_PENDING) {
      for (const [h, p] of this.pending) if (t > p.expires) this.pending.delete(h);
      if (this.pending.size >= MAX_PENDING) {
        // Anyone can start a ticketless ("who am I") sign-in, so those give way first: a flood of
        // them must not push out an owner who is half-way through verifying an agent.
        let victim = this.pending.keys().next().value as string;
        for (const [h, p] of this.pending) {
          if (!p.bound) {
            victim = h;
            break;
          }
        }
        this.pending.delete(victim);
      }
    }
    const state = token();
    const verifier = token();
    const nonce = token();
    this.pending.set(sha256(state), { verifier, cookieHash: sha256(nonce), expires: t + STATE_TTL_MS, bound });

    const { clientId, redirectUri, scopes } = this.cfg.xOAuth;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    return {
      status: 302,
      headers: {
        // %20, not "+", between scopes.
        Location: `${X_AUTHORIZE_URL}?${params.toString().replace(/\+/g, "%20")}`,
        "Set-Cookie": this.cookie(nonce, STATE_TTL_MS / 1000),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
      body: "",
    };
  }

  /** GET /auth/x/callback?code=...&state=... (or ?error=...&state=...) */
  async callback(query: URLSearchParams, cookieHeader: string | undefined): Promise<AuthResponse> {
    const off = this.unavailable();
    if (off) return off;
    try {
      return await this.finish(query, cookieHeader);
    } catch (e) {
      if (e instanceof AuthFailure) return page(e.status, "X sign-in did not complete", [e.message, "Nothing was changed."]);
      // Never the error's own text: it could quote a provider response.
      console.error(`[x-agent-mesh] X OAuth callback failed: ${e instanceof Error ? e.name : "error"}`);
      return page(502, "X sign-in did not complete", ["Could not reach X, or X answered unexpectedly. Try again in a minute.", "Nothing was changed."]);
    }
  }

  private async finish(query: URLSearchParams, cookieHeader: string | undefined): Promise<AuthResponse> {
    const t = this.now();
    const restart = "Start again from your verify_url (or /auth/x/login).";
    const state = query.get("state");
    const stateHash = state ? sha256(state) : "";
    const p = state ? this.pending.get(stateHash) : undefined;
    if (!p || t > p.expires) {
      if (p) this.pending.delete(stateHash);
      throw new AuthFailure(400, `This sign-in is unknown or has expired (it must be completed within 10 minutes). ${restart}`);
    }
    const nonce = readCookie(cookieHeader, COOKIE);
    if (!nonce || !sameHex(sha256(nonce), p.cookieHash)) {
      // Not this browser's sign-in (login CSRF), or cookies are blocked. The state stays valid for its own browser.
      throw new AuthFailure(400, `This sign-in was not started in this browser, or cookies are blocked. ${restart}`);
    }
    this.pending.delete(stateHash); // one use

    if (query.has("error")) {
      const code = (query.get("error") ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60);
      throw new AuthFailure(400, code === "access_denied" ? "You cancelled the sign-in on X." : `X reported an error${code ? ` (${code})` : ""}.`);
    }
    const code = query.get("code");
    if (!code) throw new AuthFailure(400, `X returned no authorization code. ${restart}`);
    if (p.bound && !this.tickets.has(p.bound.ticketHash)) {
      throw new AuthFailure(400, "This verification link was already used or replaced by a newer one. Ask your agent to call start_x_verification for a fresh verify_url.");
    }

    const me = await this.whoIsSignedIn(code, p.verifier);
    const who = `@${me.username} (X user id ${me.id})`;

    if (!p.bound) {
      return this.done(200, "Signed in with X", [
        `You are signed in as ${who}.`,
        "No agent was changed and no key was issued. To verify an agent, open the verify_url that register_agent or start_x_verification returned to it.",
      ]);
    }

    const agent = await this.store.getAgentByXUserId(p.bound.xUserId);
    if (!agent || agent.id !== p.bound.agentId) throw new AuthFailure(404, "The agent this link was issued for no longer exists.");
    if (me.id !== agent.x_user_id) {
      return this.done(403, "Not verified: different X account", [
        `You signed in as ${who}, but this agent is registered for X user id ${agent.x_user_id} (@${agent.x_handle}).`,
        "The agent was not verified. Sign in to X as the registered account and open the verify_url again, or register the agent with the right x_user_id.",
      ]);
    }
    const renamed = me.username.toLowerCase() !== agent.x_handle.toLowerCase();
    if (renamed) {
      const holder = await this.store.getAgentByHandle(me.username);
      if (holder && holder.x_user_id !== agent.x_user_id) {
        return this.done(409, "Not verified: handle already registered", [
          `You signed in as ${who}, which matches this agent's X user id, but the handle @${me.username} is registered on this mesh to a different agent.`,
          "The agent was not verified. Ask the mesh operator to resolve the conflict.",
        ]);
      }
    }
    await this.store.updateAgent(agent.x_user_id, { x_verified: true, ...(renamed ? { x_handle: me.username } : {}) });
    this.dropTicket(p.bound.ticketHash);
    return this.done(200, "X account verified", [
      `You signed in as ${who}. Your agent on this mesh is now verified for that account.`,
      ...(renamed ? [`Its handle was updated from @${agent.x_handle} to @${me.username}.`] : []),
      "The mesh did not keep any X token and cannot post or act on X. You can close this page.",
    ]);
  }

  /** Exchanges the code and reads the signed-in user. The tokens never leave this function. */
  private async whoIsSignedIn(code: string, verifier: string): Promise<{ id: string; username: string }> {
    const { clientId, clientSecret, redirectUri } = this.cfg.xOAuth;
    const tokenRes = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!tokenRes.ok) {
      console.error(`[x-agent-mesh] X token endpoint answered HTTP ${tokenRes.status}`); // status only: the body is never read
      throw new AuthFailure(502, `X did not accept the sign-in (token endpoint answered HTTP ${tokenRes.status}). Start again; if it keeps happening, the mesh operator should check the X app's client id, secret and callback URL.`);
    }
    const accessToken = ((await tokenRes.json()) as { access_token?: unknown } | null)?.access_token;
    if (typeof accessToken !== "string" || accessToken === "") throw new AuthFailure(502, "X answered the sign-in without an access token.");

    const meRes = await fetch(X_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!meRes.ok) {
      console.error(`[x-agent-mesh] X users/me answered HTTP ${meRes.status}`);
      throw new AuthFailure(502, `X did not return the signed-in account (HTTP ${meRes.status}). Try again in a minute.`);
    }
    const data = ((await meRes.json()) as { data?: { id?: unknown; username?: unknown } } | null)?.data;
    const id = data?.id;
    const username = data?.username;
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id) || typeof username !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(username)) {
      throw new AuthFailure(502, "X returned an account in an unexpected format.");
    }
    return { id, username };
  }

  // ---- helpers ----

  private unavailable(): AuthResponse | null {
    if (this.configured) return null;
    return page(503, "Sign in with X is not configured", ["This mesh has no X OAuth app set up (X_CLIENT_ID and X_CLIENT_SECRET), so agents cannot be verified here."]);
  }

  /** A final page that also clears the browser-binding cookie. */
  private done(status: number, title: string, lines: string[]): AuthResponse {
    return page(status, title, lines, { "Set-Cookie": this.cookie("", 0) });
  }

  private cookie(value: string, maxAgeSeconds: number): string {
    const secure = this.cfg.publicUrl.startsWith("https://") ? "; Secure" : "";
    return `${COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** A small self-contained HTML page. Every interpolated value is escaped here. */
function page(status: number, title: string, lines: string[], headers: Record<string, string> = {}): AuthResponse {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)} · x-agent-mesh</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}h1{font-size:1.4rem}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}</style>
</head><body><h1>${escapeHtml(title)}</h1>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n")}
</body></html>
`;
  return {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...headers,
    },
    body,
  };
}
