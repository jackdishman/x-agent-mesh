// The HTTP server: MCP (Streamable HTTP, stateless) at POST /mcp, A2A JSON-RPC at POST /a2a,
// agent cards, Sign in with X (/auth/x/login, /auth/x/callback) and /healthz. Plain node:http: a
// handful of routes don't need a framework.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { agentCardFor, handleA2A, meshAgentCard } from "./a2a.js";
import { LIMITS, xOAuthConfigured } from "./config.js";
import { buildMcpServer, VERSION } from "./mcp.js";
import type { CallContext, Mesh } from "./mesh.js";

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(text);
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.bodyBytes) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function context(mesh: Mesh, req: IncomingMessage): CallContext {
  const auth = req.headers.authorization;
  const m = typeof auth === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
  let ip = req.socket.remoteAddress ?? "unknown";
  if (mesh.cfg.trustProxy) {
    // The last hop is the one our own proxy appended; earlier ones are the client's claim.
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    ip = xff[xff.length - 1] ?? ip;
    // On Fly, the proxy sets Fly-Client-IP itself to the address it accepted the connection from.
    const fly = req.headers["fly-client-ip"];
    if (mesh.cfg.trustProxy === "fly" && typeof fly === "string" && fly.trim()) ip = fly.trim();
  }
  const admin = req.headers["x-mesh-admin-token"];
  return { apiKey: m?.[1], ip, adminToken: typeof admin === "string" && admin ? admin : undefined };
}

async function handleMcp(mesh: Mesh, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    // Stateless mode: no sessions, so no GET stream to open and no DELETE to end one.
    return json(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed: this MCP endpoint is stateless, use POST." } }, { Allow: "POST" });
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    if (e instanceof BodyTooLarge) return json(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } });
    return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const server = buildMcpServer(mesh, context(mesh, req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createHttpServer(mesh: Mesh): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://mesh.invalid").pathname.replace(/\/+$/, "") || "/";
        if (path === "/healthz" && req.method === "GET") {
          return json(res, 200, { ok: true, name: "x-agent-mesh", version: VERSION, store: mesh.store.kind, require_verified: mesh.cfg.requireVerified, registration: mesh.cfg.adminToken ? "invite_only" : "open", x_oauth: xOAuthConfigured(mesh.cfg) ? "configured" : "disabled" });
        }
        if (path === "/auth/x/login" || path === "/auth/x/callback") {
          if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed", message: "Open this URL in a browser (GET)." }, { Allow: "GET" });
          const query = new URL(req.url ?? "/", "http://mesh.invalid").searchParams;
          const out = path === "/auth/x/login" ? mesh.xauth.login(query, context(mesh, req).ip) : await mesh.xauth.callback(query, req.headers.cookie);
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
          const found = await agentCardFor(mesh, handle);
          return found ? json(res, 200, found) : json(res, 404, { error: "not_found", message: "No registered, opted-in agent with that handle." });
        }
        if (path === "/mcp") return await handleMcp(mesh, req, res);
        if (path === "/a2a") {
          if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed", message: "POST JSON-RPC 2.0 requests here." }, { Allow: "POST" });
          let raw: string;
          try {
            raw = await readBody(req);
          } catch {
            return json(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } });
          }
          const out = await handleA2A(mesh, context(mesh, req), raw);
          return json(res, out.status, out.body, out.headers);
        }
        return json(res, 404, { error: "not_found" });
      } catch (e) {
        console.error("[x-agent-mesh] request failed:", e);
        if (!res.headersSent) json(res, 500, { error: "internal" });
        else res.end();
      }
    })();
  });
}
