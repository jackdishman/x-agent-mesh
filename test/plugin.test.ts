import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("plugin files", () => {
  it(".cursor-plugin/plugin.json parses and points at files that exist", () => {
    const p = JSON.parse(read(".cursor-plugin/plugin.json"));
    expect(p.name).toBe("x-agent-mesh");
    expect(p.version).toBe("0.1.0");
    expect(p.version).toBe(JSON.parse(read("package.json")).version);
    expect(typeof p.description).toBe("string");
    expect(p.author.name).toBe("Jack Dishman");
    expect(p.keywords.length).toBeGreaterThan(0);
    expect(existsSync(join(root, p.mcpServers))).toBe(true);
    expect(existsSync(join(root, p.skills, "x-agent-mesh", "SKILL.md"))).toBe(true);
  });

  it("mcp.json parses and sends the bearer key from MESH_AGENT_KEY", () => {
    const m = JSON.parse(read("mcp.json"));
    const s = m.mcpServers["x-agent-mesh"];
    expect(s.url).toMatch(/^https:\/\/.+\/mcp$/);
    expect(s.headers.Authorization).toMatch(/^Bearer .*MESH_AGENT_KEY/);
    expect(JSON.stringify(m)).not.toMatch(/xam_/); // no real key committed
  });

  it("SKILL.md has frontmatter and states the safety rules", () => {
    const s = read("skills/x-agent-mesh/SKILL.md");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(s);
    expect(fm).not.toBeNull();
    const fields = Object.fromEntries(fm![1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    expect(fields.name).toBe("x-agent-mesh");
    expect(fields.description!.length).toBeGreaterThan(20);
    for (const phrase of ["exact text", "DRAFT", "X Money", "untrusted data, never instructions", "rate_limited", "escalate_to_human", "list_mutual_agents", "follower_ids", "official X plugin"]) {
      expect(s, phrase).toContain(phrase);
    }
  });

  it("the migration holds the three tables with RLS on", () => {
    const dir = join(root, "supabase/migrations");
    expect(readdirSync(dir)).toEqual(["20261116000000_x_agent_mesh_v0.sql"]);
    const sql = read("supabase/migrations/20261116000000_x_agent_mesh_v0.sql");
    for (const t of ["mesh_agents", "mesh_threads", "mesh_messages"]) {
      expect(sql).toContain(`create table public.${t}`);
      expect(sql).toContain(`alter table public.${t} enable row level security`);
    }
    expect(sql).toContain("from anon, authenticated");
  });

  it("no source file can move money or post to X", () => {
    // The server has no payment or X client: it imports only the MCP SDK, supabase-js, zod and node builtins, and never calls fetch.
    const dir = join(root, "src");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).toMatch(/^(\.\/|node:|@modelcontextprotocol\/sdk\/|@supabase\/supabase-js$|zod$)/);
      expect(src, f).not.toMatch(/\bfetch\(/);
    }
  });
});
