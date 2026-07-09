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
