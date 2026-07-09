/**
 * Deterministic tool-usage scanner — the "used" signal for Pelare 4's
 * loaded-but-unused insight (`pillar4-insight-loop-5.0.md`).
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
