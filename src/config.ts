// Everything configurable, read once from the environment. See .env.example.

export interface BucketConfig {
  /** Tokens the bucket holds when full (the burst). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export interface MeshConfig {
  /** Public base URL of this server, no trailing slash (used in agent cards). */
  publicUrl: string;
  /** MESH_REQUIRE_VERIFIED=1: unverified agents are invisible to list_mutual_agents and cannot propose. */
  requireVerified: boolean;
  /** Per-agent limit on MCP tool calls and A2A JSON-RPC calls. */
  agentRate: BucketConfig;
  /** Per-IP limit on register_agent and on requests with a missing/unknown key. */
  ipRate: BucketConfig;
  /** How long the server remembers the mutual set an agent last supplied. */
  mutualTtlMs: number;
  /** MESH_TRUST_PROXY=1: take the client IP from the last X-Forwarded-For hop. */
  trustProxy: boolean;
}

export const LIMITS = {
  goal: 2000,
  text: 4000,
  participants: 20,
  ids: 10_000,
  dataBytes: 16_384,
  memo: 280,
  question: 1000,
  bodyBytes: 1_048_576,
  readDefault: 50,
  readMax: 200,
} as const;

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number (got "${raw}")`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MeshConfig {
  const port = num(env, "PORT", 8787);
  return {
    publicUrl: (env.MESH_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
    requireVerified: env.MESH_REQUIRE_VERIFIED === "1",
    agentRate: {
      capacity: num(env, "MESH_RATE_BURST", 20),
      refillPerSec: num(env, "MESH_RATE_PER_MIN", 60) / 60,
    },
    ipRate: {
      capacity: num(env, "MESH_REGISTER_BURST", 5),
      refillPerSec: num(env, "MESH_REGISTER_PER_HOUR", 20) / 3600,
    },
    mutualTtlMs: num(env, "MESH_MUTUAL_TTL_HOURS", 24) * 3_600_000,
    trustProxy: env.MESH_TRUST_PROXY === "1",
  };
}

/** Config for tests and embedding: generous limits unless overridden. */
export function testConfig(over: Partial<MeshConfig> = {}): MeshConfig {
  return {
    publicUrl: "https://mesh.test",
    requireVerified: false,
    agentRate: { capacity: 1000, refillPerSec: 1000 },
    ipRate: { capacity: 1000, refillPerSec: 1000 },
    mutualTtlMs: 24 * 3_600_000,
    trustProxy: false,
    ...over,
  };
}
