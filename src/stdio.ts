#!/usr/bin/env node
// stdio MCP entry, for running the mesh tools as a local process instead of the hosted /mcp.
// It talks to the store directly, so it needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to share
// state with anyone (without them it uses a private in-memory store: useful only for trying the
// tools). The caller's agent key comes from MESH_AGENT_KEY. stdout is the protocol: logs go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildMcpServer } from "./mcp.js";
import { Mesh } from "./mesh.js";
import { createStore } from "./store.js";

const mesh = new Mesh(createStore(), loadConfig());
const server = buildMcpServer(mesh, { apiKey: process.env.MESH_AGENT_KEY || undefined, ip: "stdio" });
await server.connect(new StdioServerTransport());
console.error(`[x-agent-mesh] stdio MCP ready (${process.env.MESH_AGENT_KEY ? "MESH_AGENT_KEY set" : "no MESH_AGENT_KEY: only register_agent will work"})`);
