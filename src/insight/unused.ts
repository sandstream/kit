/**
 * Loaded-vs-used correlation for the insight loop. Pure + deterministic: given the loaded
 * toolchain (agent-sbom.discoverAgentToolchain) and the used signal (usage-scan.scanToolUsage),
 * identify components with no recorded reference within the covered history.
 *
 * A positive reference proves use, regardless of the call outcome.
 * Absence supports an unused verdict only with complete message capture.
 * Tool capture does not certify skill use. Missing explicit Skill references always remain unknown.
 * An unused verdict is a suggestion. Kit never removes components automatically.
 */
import type { AgentComponentInput } from "../agent-sbom.js";
import { mcpServerOf, type ToolCaptureCoverage, type ToolUsageEntry } from "./usage-scan.js";

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
  /** Capture describes retained indexed messages, not all history or uncaptured subagents. */
  scope: "retained-indexed-messages";
  /** Skill files can be read without a Skill call. Native tool coverage cannot prove semantic skill absence. */
  skillCoverage: "explicit-references-only";
  findings: UnusedFinding[];
  /** MCP servers with no recorded reference within the covered history. */
  pruneCandidates: string[];
  /** Loaded counts, for the summary line. */
  loaded: { skills: number; mcpServers: number };
}

function byName(a: AgentComponentInput, b: AgentComponentInput): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function collectServerReferences(usage: ToolUsageEntry[]): Map<string, number> {
  const serverRefs = new Map<string, number>();
  for (const e of usage) {
    const server = e.mcpServer ?? mcpServerOf(e.tool);
    if (server) serverRefs.set(server, (serverRefs.get(server) ?? 0) + e.count);
  }
  return serverRefs;
}

function findSkillUsage(
  skills: AgentComponentInput[],
  skillUsage?: Map<string, number>,
): UnusedFinding[] {
  const findings: UnusedFinding[] = [];
  for (const s of [...skills].sort(byName)) {
    // Without a skill map, the caller has supplied no evidence for this component kind.
    if (skillUsage === undefined) {
      findings.push({ kind: "skill", name: s.name, source: s.source, refs: 0, verdict: "unknown" });
      continue;
    }
    const refs = skillUsage.get(s.name) ?? 0;
    const verdict: UsageVerdict = refs > 0 ? "used" : "unknown";
    findings.push({ kind: "skill", name: s.name, source: s.source, refs, verdict });
  }
  return findings;
}

/**
 * Correlate the loaded toolchain against recorded tool usage. Deterministic:
 * findings are ordered skills-first then mcp-servers, each group by name asc.
 */
export function computeUnused(
  loaded: { skills: AgentComponentInput[]; mcpServers: AgentComponentInput[] },
  usage: ToolUsageEntry[],
  skillUsage?: Map<string, number>,
  capture?: ToolCaptureCoverage,
): UnusedReport {
  const canJudgeAbsence =
    capture?.complete === true &&
    capture.observedMessages > 0 &&
    capture.incompleteMessages === 0 &&
    capture.orphanToolCalls === 0;
  const serverRefs = collectServerReferences(usage);
  const findings = findSkillUsage(loaded.skills, skillUsage);
  const pruneCandidates: string[] = [];

  for (const m of [...loaded.mcpServers].sort(byName)) {
    const refs = serverRefs.get(m.name) ?? 0;
    const verdict: UsageVerdict = refs > 0 ? "used" : canJudgeAbsence ? "unused" : "unknown";
    if (verdict === "unused") pruneCandidates.push(m.name);
    findings.push({ kind: "mcp-server", name: m.name, source: m.source, refs, verdict });
  }

  return {
    scope: "retained-indexed-messages",
    skillCoverage: "explicit-references-only",
    findings,
    pruneCandidates,
    loaded: { skills: loaded.skills.length, mcpServers: loaded.mcpServers.length },
  };
}
