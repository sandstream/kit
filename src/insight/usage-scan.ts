/**
 * Deterministic tool-usage scanner — the "used" signal for loaded-vs-used insight.
 *
 * Zero-LLM, pure counting: kit's memory index already normalizes every agent's
 * transcript into the `tool_uses` table (one row per tool call, cross-agent), so
 * "was this tool/MCP-server actually called?" is a GROUP BY, not a re-parse of
 * each agent's JSONL format. Given the same DB, output is identical — safe to
 * diff in CI. Detection lives here (core, deterministic); only the eventual
 * skill-*authoring* may be model-assisted, around the core (never in this path).
 *
 * This module is the scanner only — the loaded-vs-used correlation + the
 * `kit insight` surface land in later steps.
 */
import type { DatabaseSync } from "node:sqlite";

export interface ToolUsageEntry {
  /** The recorded tool name, e.g. "kit_check", "Bash", "mcp__github__create_issue". */
  tool: string;
  /** How many times it was invoked across all indexed transcripts. */
  count: number;
  /** For an MCP tool (`mcp__<server>__<tool>`), the server slug; else null. */
  mcpServer: string | null;
}

/**
 * The MCP server slug behind a namespaced tool name. Claude Code / MCP name
 * tools `mcp__<server>__<tool>`; this returns `<server>` (which may itself
 * contain `__`-free segments). Returns null for non-MCP tools (Bash, kit_*, …).
 */
export function mcpServerOf(tool: string): string | null {
  if (!tool.startsWith("mcp__")) return null;
  const rest = tool.slice("mcp__".length);
  const sep = rest.indexOf("__");
  const server = sep === -1 ? rest : rest.slice(0, sep);
  return server.length > 0 ? server : null;
}

/**
 * Pure tally: count occurrences of each tool name, skipping null/blank, sorted
 * deterministically (count desc, then tool name asc) so the report is stable.
 */
export function tallyToolUsage(names: (string | null | undefined)[]): ToolUsageEntry[] {
  const counts = new Map<string, number>();
  for (const raw of names) {
    if (raw == null) continue;
    const tool = raw.trim();
    if (tool.length === 0) continue;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tool, count]) => ({ tool, count, mcpServer: mcpServerOf(tool) }))
    .sort((a, b) => b.count - a.count || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/**
 * Scan the memory DB's `tool_uses` table for every recorded tool invocation.
 * Deterministic given the DB. Returns [] when nothing has been indexed — callers
 * MUST treat "no rows" as "can't judge usage" (skip), never as "all unused".
 */
export function scanToolUsage(db: DatabaseSync): ToolUsageEntry[] {
  const rows = db.prepare("SELECT tool_name FROM tool_uses").all() as {
    tool_name: string | null;
  }[];
  return tallyToolUsage(rows.map((r) => r.tool_name));
}

/** Fast "is anything indexed?" guard so callers can emit an honest skip. */
export function hasIndexedToolUsage(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM tool_uses").get() as { n: number };
  return row.n > 0;
}

/**
 * Pure skill-usage tally. A skill invocation is recorded as a `Skill` tool call
 * whose `tool_input` JSON carries `{ "skill": "<slug>", ... }`; count per slug,
 * skipping unparseable/blank inputs. Deterministic (Map insertion is not relied
 * on — callers look up by slug). Zero-LLM: pure JSON + counting.
 */
export function tallySkillUsage(toolInputs: (string | null | undefined)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of toolInputs) {
    if (raw == null) continue;
    let slug: unknown;
    try {
      slug = (JSON.parse(raw) as { skill?: unknown }).skill;
    } catch {
      continue; // malformed tool_input — skip
    }
    if (typeof slug !== "string") continue;
    const s = slug.trim();
    if (s.length === 0) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

/**
 * Scan the memory DB for skill invocations (`tool_name = 'Skill'`), returning a
 * slug → invocation-count map. Deterministic given the DB.
 */
export function scanSkillUsage(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare("SELECT tool_input FROM tool_uses WHERE tool_name = 'Skill'").all() as {
    tool_input: string | null;
  }[];
  return tallySkillUsage(rows.map((r) => r.tool_input));
}
