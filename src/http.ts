// The HTTP server: MCP (Streamable HTTP, stateless) at POST /mcp, A2A JSON-RPC at POST /a2a,
// agent cards, Sign in with X (/auth/x/login, /auth/x/callback) and /healthz. Plain node:http: a
// handful of routes don't need a framework.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { agentCardFor, handleA2A, meshAgentCard, RPC } from "./a2a.js";
import { LIMITS, normalizeOrigin, xOAuthConfigured } from "./config.js";
import { buildMcpServer, VERSION } from "./mcp.js";
import type { CallContext, Mesh } from "./mesh.js";
import { RateLimiter } from "./ratelimit.js";

/** The whole request (headers and body) must arrive within this long: bodies are at most 1 MB. */
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 15_000;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(text);
}

const rpcError = (code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id: null, error: { code, message, ...(data === undefined ? {} : { data }) } });

class BodyTooLarge extends Error {}
/** The client went away before the whole body arrived: there is nobody to answer. */
class ClientGone extends Error {}

/**
 * The request body as text, at most `limit` bytes. A body that declares or sends more is refused
 * without being buffered. The request stream is left intact (not destroyed) so the caller can still
 * answer 413; it answers with `Connection: close`, so the rest of the body is never read.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      fn();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        return settle(() => reject(new BodyTooLarge()));
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => settle(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    req.once("error", () => settle(() => reject(new ClientGone())));
    req.once("close", () => settle(() => reject(new ClientGone())));
  });
}

/**
 * The form an address takes as a rate-limit key, or null when `raw` is not an IP address.
 * IPv4 (also when written as IPv4-mapped IPv6) is kept whole. IPv6 is cut to its /64: one
 * subscriber controls all 2^64 addresses below that, so each must not get a bucket of its own.
 */
export function ipKey(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v = isIP(s);
  if (v === 4) return s;
  if (v !== 6) return null;
  const [head = "", tail] = s.split("::") as [string, string | undefined];
  const groups = (part: string): string[] => {
    const out: string[] = [];
    for (const g of part === "" ? [] : part.split(":")) {
      const quad = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(g);
      if (quad) {
        // An embedded dotted quad stands for the last two groups.
        const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number];
        out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
      } else out.push(g.replace(/^0+(?=.)/, ""));
    }
    return out;
  };
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const all = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (all.length !== 8) return null;
  if (all.slice(0, 5).every((g) => g === "0") && all[5] === "ffff") {
    const hi = parseInt(all[6] ?? "0", 16);
    const lo = parseInt(all[7] ?? "0", 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${all.slice(0, 4).join(":")}::/64`;
}

/**
 * The address rate limits are keyed on. Without MESH_TRUST_PROXY it is the socket's peer. With it,
 * a forwarding header is believed only when it holds a well-formed IP address: anything else (a
 * client that reaches the server directly can send any text) falls back to the socket's peer, so
 * header text is never used as a limiter key.
 */
function clientIp(mesh: Mesh, req: IncomingMessage): string {
  let ip = ipKey(req.socket.remoteAddress) ?? "unknown";
  if (mesh.cfg.trustProxy) {
    // The last hop is the one our own proxy appended; earlier ones are the client's claim.
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",");
    ip = ipKey(xff[xff.length - 1]) ?? ip;
    // On Fly, the proxy sets Fly-Client-IP itself to the address it accepted the connection from.
    const fly = req.headers["fly-client-ip"];
    if (mesh.cfg.trustProxy === "fly" && typeof fly === "string") ip = ipKey(fly) ?? ip;
  }
  return ip;
}

function context(req: IncomingMessage, ip: string): CallContext {
  const auth = req.headers.authorization;
  const m = typeof auth === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
  const admin = req.headers["x-mesh-admin-token"];
  return { apiKey: m?.[1], ip, adminToken: typeof admin === "string" && admin ? admin : undefined };
}

/**
 * DNS-rebinding protection for the two agent endpoints (the MCP spec asks servers to validate
 * `Origin`). Browsers attach `Origin` to every cross-origin POST, and a page cannot remove or forge
 * it, so a page on another site (or one that re-pointed its own host name at this server) is
 * refused here whatever key it holds. Agent clients are not browsers and send no `Origin`: a
 * request without the header is always let through.
 */
export function originAllowed(allowed: string[] | "*", header: string | string[] | undefined): boolean {
  if (header === undefined) return true;
  if (allowed === "*") return true;
  if (typeof header !== "string") return false;
  const origin = normalizeOrigin(header);
  return origin !== null && allowed.includes(origin);
}

/** True unless the request names a media type that is not JSON (a missing Content-Type is let through). */
function jsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  if (raw === undefined || raw.trim() === "") return true;
  const type = (raw.split(";")[0] ?? "").trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

async function handleMcp(mesh: Mesh, ctx: CallContext, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    // Stateless mode: no sessions, so no GET stream to open and no DELETE to end one.
    return json(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed: this MCP endpoint is stateless, use POST." } }, { Allow: "POST" });
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, LIMITS.bodyBytes));
  } catch (e) {
    if (e instanceof ClientGone) throw e;
    if (e instanceof BodyTooLarge) return json(res, 413, rpcError(RPC.invalidRequest, "Request body too large"), { Connection: "close" });
    return json(res, 400, rpcError(RPC.parse, "Parse error"));
  }
  const server = buildMcpServer(mesh, ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    // Never let a failed close become an unhandled rejection (which would end the process).
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createHttpServer(mesh: Mesh): Server {
  /** Every request except /healthz, per client address, before anything is parsed or looked up. */
  const limiter = new RateLimiter(mesh.cfg.httpRate, mesh.now);
  /** Agent-card lookups by handle, per client address. */
  const cardLimiter = new RateLimiter(mesh.cfg.cardRate, mesh.now);
  const hsts = mesh.cfg.publicUrl.startsWith("https://");

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (hsts) res.setHeader("Strict-Transport-Security", "max-age=31536000");
        let url: URL;
        try {
          url = new URL(req.url ?? "/", "http://mesh.invalid");
        } catch {
          return json(res, 400, { error: "bad_request", message: "Malformed request URL." }, { Connection: "close" });
        }
        const path = url.pathname.replace(/\/+$/, "") || "/";
        if (path === "/healthz" && req.method === "GET") {
          return json(res, 200, { ok: true, name: "x-agent-mesh", version: VERSION, store: mesh.store.kind, require_verified: mesh.cfg.requireVerified, registration: mesh.cfg.adminToken ? "invite_only" : "open", x_oauth: xOAuthConfigured(mesh.cfg) ? "configured" : "disabled" });
        }

        const ip = clientIp(mesh, req);
        const wait = limiter.take(ip);
        if (wait > 0) {
          // The body (if any) is not read: close the connection instead of draining it.
          const headers = { "Retry-After": String(wait), Connection: "close" };
          const message = `Too many requests from this address. Wait ${wait} seconds before trying again; do not retry in a loop.`;
          if (path === "/mcp" || path === "/a2a") return json(res, 429, rpcError(RPC.rateLimited, "Rate limit exceeded", { retry_after_seconds: wait, detail: message }), headers);
          return json(res, 429, { error: "rate_limited", message, retry_after_seconds: wait }, headers);
        }

        if ((path === "/mcp" || path === "/a2a") && !originAllowed(mesh.cfg.allowedOrigins, req.headers.origin)) {
          // Before the body is read, the key is looked at or anything is run. The body is not read: close.
          return json(
            res,
            403,
            rpcError(RPC.forbidden, "Origin not allowed", "This endpoint does not accept requests from this web origin. Agent clients should send no Origin header; a browser app must be listed in the server's MESH_ALLOWED_ORIGINS."),
            { Connection: "close" },
          );
        }

        if (path === "/auth/x/login" || path === "/auth/x/callback") {
          if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed", message: "Open this URL in a browser (GET)." }, { Allow: "GET" });
          const query = url.searchParams;
          const out = path === "/auth/x/login" ? mesh.xauth.login(query, ip) : await mesh.xauth.callback(query, req.headers.cookie);
          res.writeHead(out.status, { ...out.headers, "Content-Length": Buffer.byteLength(out.body) });
          return res.end(out.body);
        }
        if (path === "/.well-known/agent-card.json" && req.method === "GET") {
          return json(res, 200, meshAgentCard(mesh), { "Cache-Control": "public, max-age=300" });
        }
        const card = /^\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/.exec(path);
        if (card && req.method === "GET") {
          let handle = "";
          try {
            handle = decodeURIComponent(card[1] ?? "").replace(/^@/, "");
          } catch {
            /* malformed escape: falls through to 404 */
          }
          // Every lookup counts, found or not, well-formed or not: the answer says whether a handle
          // is registered, so how many handles one address may ask about is bounded.
          const cardWait = cardLimiter.take(ip);
          if (cardWait > 0) {
            return json(res, 429, { error: "rate_limited", message: `Too many agent-card lookups from this address. Wait ${cardWait} seconds before trying again; do not retry in a loop.`, retry_after_seconds: cardWait }, { "Retry-After": String(cardWait) });
          }
          // One answer for every reason there is no card to show: never registered, opted out,
          // unverified on a verified-only mesh, or not a possible handle at all.
          const found = await agentCardFor(mesh, handle);
          return found ? json(res, 200, found) : json(res, 404, { error: "not_found", message: "No registered, opted-in agent with that handle." });
        }
        if (path === "/mcp") return await handleMcp(mesh, context(req, ip), req, res);
        if (path === "/a2a") {
          if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed", message: "POST JSON-RPC 2.0 requests here." }, { Allow: "POST" });
          if (!jsonContentType(req)) return json(res, 415, rpcError(RPC.invalidRequest, "Unsupported media type: send application/json"), { Connection: "close" });
          let raw: string;
          try {
            raw = await readBody(req, LIMITS.a2aBodyBytes);
          } catch (e) {
            if (e instanceof ClientGone) throw e;
            return json(res, 413, rpcError(RPC.invalidRequest, "Request body too large"), { Connection: "close" });
          }
          const out = await handleA2A(mesh, context(req, ip), raw);
          return json(res, out.status, out.body, out.headers);
        }
        return json(res, 404, { error: "not_found" });
      } catch (e) {
        if (e instanceof ClientGone) return void res.destroy();
        console.error("[x-agent-mesh] request failed:", e);
        if (!res.headersSent) json(res, 500, { error: "internal" });
        else res.end();
      }
    })();
  });
  // Slow senders: Node's defaults (60 s for headers, 5 min for the request) hold a connection far
  // longer than a 1 MB JSON request needs.
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
