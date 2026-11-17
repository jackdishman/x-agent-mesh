#!/usr/bin/env node
// stdio MCP entry, for running the mesh tools as a local process instead of the hosted /mcp.
// It opens the store directly, with the same selection as the HTTP server (createStore: Supabase
// if configured, MESH_STORE=memory, else the SQLite file at MESH_SQLITE_PATH), so it shares state
// only with processes using that same store. The caller's agent key comes from MESH_AGENT_KEY.
// The local operator is trusted: if MESH_ADMIN_TOKEN is set, it is used as the registration token.
// stdout is the protocol: logs go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildMcpServer } from "./mcp.js";
import { Mesh } from "./mesh.js";
import { createStore } from "./store.js";

const mesh = new Mesh(createStore(), loadConfig());
const server = buildMcpServer(mesh, { apiKey: process.env.MESH_AGENT_KEY || undefined, ip: "stdio", adminToken: process.env.MESH_ADMIN_TOKEN || undefined });
await server.connect(new StdioServerTransport());
console.error(`[x-agent-mesh] stdio MCP ready (${process.env.MESH_AGENT_KEY ? "MESH_AGENT_KEY set" : "no MESH_AGENT_KEY: only register_agent will work"})`);
