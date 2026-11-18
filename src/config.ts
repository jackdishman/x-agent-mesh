// Everything configurable, read once from the environment. See .env.example.

export interface BucketConfig {
  /** Tokens the bucket holds when full (the burst). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

/** The X OAuth 2.0 app (a confidential "Web App" client). `clientSecret` is a secret: never log it. */
export interface XOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match a callback URL registered on the X app exactly. */
  redirectUri: string;
  /** Space-separated. No offline.access: the mesh discards X tokens and never acts on X. */
  scopes: string;
}

/** Sign in with X is on only when both the client id and the client secret are set. */
export const xOAuthConfigured = (cfg: MeshConfig): boolean => cfg.xOAuth.clientId !== "" && cfg.xOAuth.clientSecret !== "";

export interface MeshConfig {
  /** Public base URL of this server, no trailing slash (used in agent cards). */
  publicUrl: string;
  /** MESH_REQUIRE_VERIFIED=1: unverified agents are invisible to list_mutual_agents and cannot propose. */
  requireVerified: boolean;
  /** Per-agent limit on MCP tool calls and A2A JSON-RPC calls. */
  agentRate: BucketConfig;
  /** Per-IP limit on register_agent and on requests with a missing/unknown key. */
  ipRate: BucketConfig;
  /** Per-IP limit on every HTTP request except /healthz, taken before any routing, parsing or auth. */
  httpRate: BucketConfig;
  /**
   * Per-agent budget of stored bytes (goals, message text and data): capacity in bytes, refill in
   * bytes per second. Keeps one agent from filling the disk; the request-count limit alone would
   * let a single key store about 1 GB a day.
   */
  writeRate: BucketConfig;
  /** How long the server remembers the mutual set an agent last supplied. */
  mutualTtlMs: number;
  /**
   * MESH_TRUST_PROXY=1: take the client IP from the last X-Forwarded-For hop.
   * MESH_TRUST_PROXY=fly: take it from Fly-Client-IP, which Fly's proxy sets itself (falls back to the last X-Forwarded-For hop).
   */
  trustProxy: boolean | "fly";
  /**
   * MESH_ADMIN_TOKEN: when non-empty, register_agent needs this invite token (argument `admin_token`
   * or header `X-Mesh-Admin-Token`). Empty = registration is open. A secret: never log it.
   */
  adminToken: string;
  /** X_CLIENT_ID, X_CLIENT_SECRET, X_REDIRECT_URI, X_OAUTH_SCOPES. */
  xOAuth: XOAuthConfig;
}

export const LIMITS = {
  goal: 2000,
  text: 4000,
  participants: 20,
  ids: 10_000,
  dataBytes: 16_384,
  memo: 280,
  question: 1000,
  /** POST /mcp: two lists of 10,000 ids fit in well under 1 MB. */
  bodyBytes: 1_048_576,
  /** POST /a2a: no id lists, so a message (text + 16 KB of data) never needs more. */
  a2aBodyBytes: 262_144,
  /** Longest bearer key / invite token header the server looks at. Real keys are 47 characters. */
  credentialChars: 512,
  /** Total ids across all remembered mutual sets (the cache is the largest thing held in memory). */
  mutualIdsTotal: 200_000,
  /** The smallest per-agent write budget: one maximal message must always fit. */
  minWriteBurstBytes: 65_536,
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

/** Checks `raw` is an absolute http(s) URL without credentials, query or fragment; returns it without trailing slashes. */
function baseUrl(name: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash) {
    throw new Error(`${name} must be an http(s) URL without credentials, query string or fragment`);
  }
  return raw.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MeshConfig {
  const port = num(env, "PORT", 8787);
  const adminToken = env.MESH_ADMIN_TOKEN ?? "";
  if (env.MESH_REQUIRE_ADMIN_TOKEN === "1" && adminToken === "") {
    throw new Error("MESH_REQUIRE_ADMIN_TOKEN=1 but MESH_ADMIN_TOKEN is empty: refusing to start with open registration. Set the MESH_ADMIN_TOKEN secret.");
  }
  const publicUrl = baseUrl("MESH_PUBLIC_URL", (env.MESH_PUBLIC_URL || `http://localhost:${port}`).trim());
  const redirectUri = (env.X_REDIRECT_URI ?? "").trim() || `${publicUrl}/auth/x/callback`;
  baseUrl("X_REDIRECT_URI", redirectUri);
  const writeBytesPerDay = Math.max(LIMITS.minWriteBurstBytes, Math.floor(num(env, "MESH_WRITE_KB_PER_DAY", 5120) * 1024));
  const scopes = (env.X_OAUTH_SCOPES || "users.read tweet.read").trim().split(/\s+/).join(" ");
  if (scopes.split(" ").includes("offline.access")) {
    throw new Error("X_OAUTH_SCOPES must not include offline.access: the mesh discards X tokens and never needs a refresh token.");
  }
  return {
    publicUrl,
    requireVerified: env.MESH_REQUIRE_VERIFIED === "1",
    agentRate: {
      capacity: num(env, "MESH_RATE_BURST", 20),
      refillPerSec: num(env, "MESH_RATE_PER_MIN", 60) / 60,
    },
    ipRate: {
      capacity: num(env, "MESH_REGISTER_BURST", 5),
      refillPerSec: num(env, "MESH_REGISTER_PER_HOUR", 20) / 3600,
    },
    httpRate: {
      capacity: num(env, "MESH_HTTP_BURST", 240),
      refillPerSec: num(env, "MESH_HTTP_PER_MIN", 1200) / 60,
    },
    writeRate: { capacity: writeBytesPerDay, refillPerSec: writeBytesPerDay / 86_400 },
    mutualTtlMs: num(env, "MESH_MUTUAL_TTL_HOURS", 24) * 3_600_000,
    trustProxy: env.MESH_TRUST_PROXY === "fly" ? "fly" : env.MESH_TRUST_PROXY === "1",
    adminToken,
    xOAuth: {
      clientId: (env.X_CLIENT_ID ?? "").trim(),
      clientSecret: (env.X_CLIENT_SECRET ?? "").trim(),
      redirectUri,
      scopes,
    },
  };
}

/** Config for tests and embedding: generous limits unless overridden. */
export function testConfig(over: Partial<MeshConfig> = {}): MeshConfig {
  return {
    publicUrl: "https://mesh.test",
    requireVerified: false,
    agentRate: { capacity: 1000, refillPerSec: 1000 },
    ipRate: { capacity: 1000, refillPerSec: 1000 },
    httpRate: { capacity: 100_000, refillPerSec: 100_000 },
    writeRate: { capacity: 1_000_000_000, refillPerSec: 1_000_000 },
    mutualTtlMs: 24 * 3_600_000,
    trustProxy: false,
    adminToken: "",
    xOAuth: { clientId: "", clientSecret: "", redirectUri: "https://mesh.test/auth/x/callback", scopes: "users.read tweet.read" },
    ...over,
  };
}
