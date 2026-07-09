/**
 * kit — agent-toolchain SBOM (G5).
 *
 * The LLM supply-chain research agenda (Wang et al., arXiv:2404.12736 / ACM TOSEM
 * 34(5), doi:10.1145/3708531; verified 3-0 in kit's gap analysis §2.5) names an SBOM
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
 * Best-effort, defensive discovery of the agent-toolchain pieces loaded under
 * `cwd` — skills (each `.claude/skills/<name>/SKILL.md`) and MCP servers (union
 * across the common config locations, via mcpServersFromConfig). Pure filesystem
 * read; missing/malformed inputs are skipped, never thrown. Shared by
 * `kit sbom --agent` and `kit insight` so both see the SAME loaded set.
 */
export function discoverAgentToolchain(cwd: string): {
  skills: AgentComponentInput[];
  mcpServers: AgentComponentInput[];
} {
  const skills: AgentComponentInput[] = [];
  const skillsDir = resolve(cwd, ".claude/skills");
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(resolve(skillsDir, entry.name, "SKILL.md"))) {
        skills.push({ name: entry.name, source: `.claude/skills/${entry.name}` });
      }
    }
  } catch {
    /* no skills dir — fine */
  }

  const mcpServers: AgentComponentInput[] = [];
  const seen = new Set<string>();
  for (const rel of [".mcp.json", ".claude.json", ".cursor/mcp.json", ".vscode/mcp.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(cwd, rel), "utf8"));
      for (const s of mcpServersFromConfig(parsed)) {
        if (!seen.has(s.name)) {
          seen.add(s.name);
          mcpServers.push(s);
        }
      }
    } catch {
      /* missing/malformed config — skip */
    }
  }
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
