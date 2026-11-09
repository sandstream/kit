/**
 * Count references in the tool_uses table and inspect message capture coverage.
 * Capture describes native records in retained indexed transcripts. It cannot certify all history or uncaptured subagents.
 * No transcript parsing or model calls occur here. Equal database contents produce equal output.
 */
import type { DatabaseSync } from "node:sqlite";

/** Coverage of retained indexed messages, independent of whether any tool calls were recorded. */
export interface ToolCaptureCoverage {
  /** All observed messages have version 1, valid matching call counts, and no orphan calls. */
  complete: boolean;
  observedMessages: number;
  incompleteMessages: number;
  orphanToolCalls: number;
}

export interface ToolUsageEntry {
  /** The recorded tool name, e.g. "kit_check", "Bash", "mcp__github__create_issue". */
  tool: string;
  /** Number of recorded calls, regardless of their execution outcome. */
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
 * Empty output does not establish absence. Check message capture before a negative verdict.
 */
export function scanToolUsage(db: DatabaseSync): ToolUsageEntry[] {
  const rows = db.prepare("SELECT tool_name FROM tool_uses").all() as {
    tool_name: string | null;
  }[];
  return tallyToolUsage(rows.map((r) => r.tool_name));
}

/** Reports whether call rows exist. This is not evidence of complete capture. */
export function hasIndexedToolUsage(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM tool_uses").get() as { n: number };
  return row.n > 0;
}

/** Version 1 and a matching expected call count certify native capture for a retained message. */
export function scanToolCapture(db: DatabaseSync): ToolCaptureCoverage {
  const columns = db.prepare("PRAGMA table_info(messages)").all();
  const hasCaptureFields = ["tool_capture_version", "tool_capture_count"].every((name) =>
    columns.some((column) => column.name === name),
  );
  const completeMessages = hasCaptureFields
    ? `COUNT(CASE WHEN m.tool_capture_version = 1 AND typeof(m.tool_capture_version) = 'integer'
        AND typeof(m.tool_capture_count) = 'integer' AND m.tool_capture_count >= 0
        AND m.tool_capture_count = COALESCE(recorded.n, 0) THEN 1 END)`
    : "0";
  const row = db
    .prepare(
      `
    WITH recorded_calls AS (
      SELECT message_uuid, session_id, COUNT(*) AS n
      FROM tool_uses GROUP BY message_uuid, session_id
    )
    SELECT COUNT(*) AS observedMessages,
      COUNT(*) - ${completeMessages} AS incompleteMessages
    FROM messages AS m LEFT JOIN recorded_calls AS recorded
      ON recorded.message_uuid = m.uuid AND recorded.session_id = m.session_id
  `,
    )
    .get() as { observedMessages: number; incompleteMessages: number };
  const orphan = db
    .prepare(
      `
    SELECT COUNT(*) AS n FROM tool_uses AS calls
    WHERE NOT EXISTS (
      SELECT 1 FROM messages
      WHERE messages.uuid = calls.message_uuid AND messages.session_id = calls.session_id
    )
  `,
    )
    .get() as { n: number };
  return {
    complete: row.observedMessages > 0 && row.incompleteMessages === 0 && orphan.n === 0,
    ...row,
    orphanToolCalls: orphan.n,
  };
}

/**
 * Count explicit Skill references from tool_input JSON containing {skill:<slug>}.
 * Direct file reads and opaque dispatch code do not provide a complete skill-use signal.
 * Skip malformed or blank inputs. This tally cannot establish skill absence.
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
 * Scan explicit Skill call records and return reference counts by slug.
 * Positive records prove a reference regardless of outcome. Missing records do not prove skill absence.
 */
export function scanSkillUsage(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare("SELECT tool_input FROM tool_uses WHERE tool_name = 'Skill'").all() as {
    tool_input: string | null;
  }[];
  return tallySkillUsage(rows.map((r) => r.tool_input));
}
