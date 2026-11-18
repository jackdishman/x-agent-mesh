#!/usr/bin/env node
// HTTP entry: `npm run dev` / `npm start`.
import { loadConfig, xOAuthConfigured } from "./config.js";
import { createHttpServer } from "./http.js";
import { Mesh } from "./mesh.js";
import { createStore } from "./store.js";

const cfg = loadConfig();
const mesh = new Mesh(createStore(), cfg);
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";

const server = createHttpServer(mesh);
server.listen(port, host, () => {
  console.error(`[x-agent-mesh] listening on http://${host}:${port} (public URL ${cfg.publicUrl})`);
  console.error(`[x-agent-mesh] MCP: POST /mcp · A2A: POST /a2a · card: GET /.well-known/agent-card.json · health: GET /healthz`);
  console.error(`[x-agent-mesh] registration: ${cfg.adminToken ? "invite-only (MESH_ADMIN_TOKEN is set)" : "OPEN (no MESH_ADMIN_TOKEN): do not expose this server publicly"}`);
  console.error(`[x-agent-mesh] storage quota: ${cfg.agentQuotaBytes > 0 ? `${Math.round(cfg.agentQuotaBytes / 1024)} KB per agent (MESH_AGENT_QUOTA_KB)` : "none (MESH_AGENT_QUOTA_KB=0)"}`);
  console.error(`[x-agent-mesh] X OAuth: ${xOAuthConfigured(cfg) ? `configured (callback ${cfg.xOAuth.redirectUri})` : "DISABLED (X_CLIENT_ID / X_CLIENT_SECRET not set): agents cannot be verified"}${cfg.requireVerified ? "; MESH_REQUIRE_VERIFIED=1, so unverified agents are hidden and cannot propose" : ""}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
