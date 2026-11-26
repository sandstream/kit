/**
 * kit — agent-toolchain SBOM (G5).
 *
 * The LLM supply-chain literature (Wang et al., arXiv:2404.12736 / ACM TOSEM
 * 34(5), doi:10.1145/3708531) names an SBOM
 * for the AI/LLM *toolchain* as an unrealized transparency/security opportunity: the
 * pieces an agent actually loads — skills, MCP servers, plugins — are supply-chain
 * components too, but no lockfile lists them, so today's SBOM can't see them.
 *
 * This maps those agent-toolchain pieces into the SAME CycloneDX/SPDX `Component`
 * shape kit already emits for npm deps, so `kit sbom --agent` produces one BOM that
 * covers both. Pure + deterministic (data → components); discovery is best-effort and
 * kept separate.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Component } from "./sbom.js";

export type AgentComponentKind = "skill" | "mcp-server" | "plugin";

export interface AgentComponentInput {
  name: string;
  version?: string;
  /** Provenance: a file path, server command, or source string. */
  source?: string;
}

export interface AgentToolchainInput {
  skills?: AgentComponentInput[];
  mcpServers?: AgentComponentInput[];
  plugins?: AgentComponentInput[];
}

const DEFAULT_VERSION = "0.0.0";

/** purl namespace per kind — `pkg:generic/<kind>/<name>@<version>`. */
function agentPurl(kind: AgentComponentKind, name: string, version: string): string {
  return `pkg:generic/${kind}/${encodeURIComponent(name)}@${version}`;
}

/**
 * Map discovered agent-toolchain pieces into SBOM `Component`s. Pure + deterministic:
 * de-duplicated by (kind, name, version) and sorted for a stable BOM. An unversioned
 * piece gets `0.0.0` (the registry/config rarely pins agent components).
 */
export function agentToolchainComponents(input: AgentToolchainInput): Component[] {
  const out: Component[] = [];
  const seen = new Set<string>();
  const add = (kind: AgentComponentKind, items: AgentComponentInput[] | undefined) => {
    for (const it of items ?? []) {
      if (!it.name || !it.name.trim()) continue;
      const version = it.version?.trim() || DEFAULT_VERSION;
      const key = `${kind}:${it.name}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: it.name,
        version,
        type: "application",
        purl: agentPurl(kind, it.name, version),
        provenance: it.source ? `${kind}: ${it.source}` : kind,
      });
    }
  };
  add("skill", input.skills);
  add("mcp-server", input.mcpServers);
  add("plugin", input.plugins);
  return out.sort((a, b) => (a.purl ?? a.name).localeCompare(b.purl ?? b.name));
}

/**
 * Extract MCP servers from a parsed agent/editor config object (Claude/Cursor/VSCode
 * nest them under `mcpServers` or `servers`). Pure. Returns [] on anything unexpected.
 */
export function mcpServersFromConfig(json: unknown): AgentComponentInput[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const servers = (obj.mcpServers ?? obj.servers) as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return [];
  const out: AgentComponentInput[] = [];
  for (const [name, def] of Object.entries(servers)) {
    const d = (def ?? {}) as Record<string, unknown>;
    const command = typeof d.command === "string" ? d.command : undefined;
    const url = typeof d.url === "string" ? d.url : undefined;
    out.push({ name, source: command ?? url });
  }
  return out;
}

/**
 * Where a project's skills live, per harness: Claude Code's `.claude/skills`, then Codex's
 * `.agents/skills` and `.codex/skills` (where older Codex versions installed them). Reading only
 * the first left every Codex skill out of `kit insight` and `kit profile freeze` (kit-research
 * `uber-skills-at-scale-vs-kit`).
 */
export const PROJECT_SKILL_DIRS = [".claude/skills", ".agents/skills", ".codex/skills"] as const;

/** JSON MCP configs: Claude Code, Cursor and VS Code nest servers under `mcpServers`/`servers`. */
const MCP_JSON_CONFIGS = [".mcp.json", ".claude.json", ".cursor/mcp.json", ".vscode/mcp.json"];

/** Codex's project MCP servers: the `[mcp_servers.<name>]` tables in `.codex/config.toml`. */
function codexMcpServers(cwd: string): AgentComponentInput[] {
  try {
    const parsed = parseToml(readFileSync(resolve(cwd, ".codex", "config.toml"), "utf8"));
    return mcpServersFromConfig({ mcpServers: parsed.mcp_servers });
  } catch {
    return []; // missing/malformed config — skip
  }
}

function jsonMcpServers(cwd: string, rel: string): AgentComponentInput[] {
  try {
    return mcpServersFromConfig(JSON.parse(readFileSync(resolve(cwd, rel), "utf8")));
  } catch {
    return []; // missing/malformed config — skip
  }
}

/** The skill directories under `cwd/<rel>` that hold a SKILL.md. Missing dir → []. */
function skillsIn(cwd: string, rel: string): AgentComponentInput[] {
  const dir = resolve(cwd, rel);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(resolve(dir, e.name, "SKILL.md")))
      .map((e) => ({ name: e.name, source: `${rel}/${e.name}` }));
  } catch {
    return []; // no skills dir — fine
  }
}

/** The first entry for each name, in order. */
function firstByName(items: AgentComponentInput[]): AgentComponentInput[] {
  const seen = new Set<string>();
  return items.filter((it) => !seen.has(it.name) && seen.add(it.name));
}

/**
 * Best-effort, defensive discovery of the agent-toolchain pieces loaded under
 * `cwd` — skills (each `<dir>/<name>/SKILL.md` for every PROJECT_SKILL_DIRS entry) and MCP
 * servers (union across the JSON configs and Codex's `.codex/config.toml`), each name once,
 * the first harness's entry kept. Pure filesystem read; missing/malformed inputs are skipped,
 * never thrown. Shared by `kit sbom --agent` and `kit insight` so both see the SAME loaded set.
 */
export function discoverAgentToolchain(cwd: string): {
  skills: AgentComponentInput[];
  mcpServers: AgentComponentInput[];
} {
  const skills = firstByName(PROJECT_SKILL_DIRS.flatMap((rel) => skillsIn(cwd, rel)));
  const mcpServers = firstByName([
    ...MCP_JSON_CONFIGS.flatMap((rel) => jsonMcpServers(cwd, rel)),
    ...codexMcpServers(cwd),
  ]);
  return { skills, mcpServers };
}

/**
 * Best-effort discovery of the plugins a project loads: the `kitPlugins` array in
 * `package.json` (npm package names; the same list `loadPluginAdapters` consumes). When the
 * plugin is installed, its version is read from `node_modules/<name>/package.json`. Pure
 * filesystem read; missing/malformed inputs yield `[]`, never throw — matching
 * `discoverAgentToolchain`'s defensive posture. Kept separate so it can be composed without
 * changing `discoverAgentToolchain`'s shape (and its `kit sbom --agent` / `kit insight` callers).
 */
export function discoverPlugins(cwd: string): AgentComponentInput[] {
  let names: string[];
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const raw = pkg.kitPlugins;
    names = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
  const out: AgentComponentInput[] = [];
  for (const name of names) {
    let version: string | undefined;
    try {
      const dep = JSON.parse(
        readFileSync(resolve(cwd, "node_modules", name, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      if (typeof dep.version === "string") version = dep.version;
    } catch {
      /* plugin not installed — declared name only */
    }
    out.push({ name, version, source: "package.json:kitPlugins" });
  }
  return out;
}
