/**
 * Loaded-vs-used correlation for Pelare 4's insight loop
 * (`pillar4-insight-loop-5.0.md`). Pure + deterministic: given the loaded
 * toolchain (agent-sbom.discoverAgentToolchain) and the used signal
 * (usage-scan.scanToolUsage), decide which loaded MCP servers were never called.
 *
 * Honesty rules (no false green):
 * - MCP servers correlate cleanly (a call is `mcp__<server>__<tool>`), so they get
 *   a real used/unused verdict.
 * - Skills correlate via the `Skill` tool's `{skill:<slug>}` input (exact slug
 *   match against the loaded skill's directory name) — a real used/unused verdict.
 *   Passing no skill-usage map falls back to "unknown" (never "unused").
 * - "unused" is a PRUNE SUGGESTION, never an automatic removal.
 */
import type { AgentComponentInput } from "../agent-sbom.js";
import { mcpServerOf, type ToolUsageEntry } from "./usage-scan.js";

export type UsageVerdict = "used" | "unused" | "unknown";

export interface UnusedFinding {
  kind: "skill" | "mcp-server";
  name: string;
  source?: string;
  /** Recorded invocations attributable to this component (0 for unused/unknown). */
  refs: number;
  verdict: UsageVerdict;
}

export interface UnusedReport {
  findings: UnusedFinding[];
  /** MCP servers loaded but never called — the (confident) prune suggestions. */
  pruneCandidates: string[];
  /** Loaded counts, for the summary line. */
  loaded: { skills: number; mcpServers: number };
}

/**
 * Correlate the loaded toolchain against recorded tool usage. Deterministic:
 * findings are ordered skills-first then mcp-servers, each group by name asc.
 */
export function computeUnused(
  loaded: { skills: AgentComponentInput[]; mcpServers: AgentComponentInput[] },
  usage: ToolUsageEntry[],
  skillUsage?: Map<string, number>,
): UnusedReport {
  // Sum recorded refs per MCP server across all its tools.
  const serverRefs = new Map<string, number>();
  for (const e of usage) {
    const server = e.mcpServer ?? mcpServerOf(e.tool);
    if (server) serverRefs.set(server, (serverRefs.get(server) ?? 0) + e.count);
  }

  const byName = (a: AgentComponentInput, b: AgentComponentInput) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

  const findings: UnusedFinding[] = [];
  const pruneCandidates: string[] = [];

  for (const s of [...loaded.skills].sort(byName)) {
    // With a skill-usage map, judge by exact-slug invocation count; without one,
    // stay honest ("unknown" — never "unused").
    if (skillUsage === undefined) {
      findings.push({ kind: "skill", name: s.name, source: s.source, refs: 0, verdict: "unknown" });
      continue;
    }
    const refs = skillUsage.get(s.name) ?? 0;
    const verdict: UsageVerdict = refs > 0 ? "used" : "unused";
    if (verdict === "unused") pruneCandidates.push(s.name);
    findings.push({ kind: "skill", name: s.name, source: s.source, refs, verdict });
  }

  for (const m of [...loaded.mcpServers].sort(byName)) {
    const refs = serverRefs.get(m.name) ?? 0;
    const verdict: UsageVerdict = refs > 0 ? "used" : "unused";
    if (verdict === "unused") pruneCandidates.push(m.name);
    findings.push({ kind: "mcp-server", name: m.name, source: m.source, refs, verdict });
  }

  return {
    findings,
    pruneCandidates,
    loaded: { skills: loaded.skills.length, mcpServers: loaded.mcpServers.length },
  };
}
