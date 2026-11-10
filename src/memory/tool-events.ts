import type { DatabaseSync } from "node:sqlite";
import type { MessageInput, ToolUseInput } from "./types.js";

/** A transcript result is reported evidence, not proof of an external effect. */
export type ToolOutcome = "unknown" | "returned" | "error" | "denied" | "conflict";

export function toolOutcome(value: unknown): ToolOutcome {
  return value === "returned" || value === "error" || value === "denied" || value === "conflict"
    ? value
    : "unknown";
}

/** Unknown evidence cannot erase a result. Contradictory results stay visible. */
export function mergeToolOutcome(left: ToolOutcome, right: ToolOutcome): ToolOutcome {
  if (left === "unknown") return right;
  if (right === "unknown" || left === right) return left;
  if ((left === "error" && right === "denied") || (left === "denied" && right === "error"))
    return "denied";
  return "conflict";
}

export function prepareToolEvidence(db: DatabaseSync): void {
  const fields = [
    ["tool_uses", "call_id", "TEXT"],
    ["tool_uses", "outcome", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["tool_uses", "outcome_at", "TEXT"],
    ["messages", "tool_capture_version", "INTEGER NOT NULL DEFAULT 0"],
    ["messages", "tool_capture_count", "INTEGER"],
    ["file_index", "parser_version", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [table, column, declaration] of fields) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((row) => row.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_call_identity ON tool_uses(session_id, call_id) WHERE call_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tool_message ON tool_uses(message_uuid, session_id);
    CREATE TRIGGER IF NOT EXISTS messages_tools_ad AFTER DELETE ON messages BEGIN
      DELETE FROM tool_uses WHERE message_uuid = old.uuid;
    END;
    DELETE FROM tool_uses WHERE message_uuid IN (SELECT uuid FROM memory_tombstones);
  `);
}

/** Update a result only when its session and call identifier match a retained request. */
export function recordToolOutcome(
  db: DatabaseSync,
  sessionId: string,
  callId: string,
  outcome: ToolOutcome,
  timestamp?: string,
): boolean {
  if (outcome === "unknown") return false;
  const row = db
    .prepare("SELECT id, outcome, outcome_at FROM tool_uses WHERE session_id = ? AND call_id = ?")
    .get(sessionId, callId);
  if (!row) return false;
  const combined = mergeToolOutcome(toolOutcome(row.outcome), outcome);
  const previous = typeof row.outcome_at === "string" ? row.outcome_at : undefined;
  const at = timestamp && (!previous || timestamp > previous) ? timestamp : previous;
  if (combined === row.outcome && (at ?? null) === row.outcome_at) return false;
  db.prepare("UPDATE tool_uses SET outcome = ?, outcome_at = ? WHERE id = ?").run(
    combined,
    at ?? null,
    row.id,
  );
  return true;
}

/** Adopt a legacy row only at the same message position with the same request bytes. */
function adoptLegacyCall(db: DatabaseSync, input: ToolUseInput): boolean {
  if (input.ordinal === undefined) return false;
  const row = db
    .prepare(
      "SELECT * FROM tool_uses WHERE message_uuid = ? AND session_id = ? ORDER BY id LIMIT 1 OFFSET ?",
    )
    .get(input.messageUuid!, input.sessionId!, input.ordinal);
  if (
    !row ||
    row.call_id !== null ||
    row.tool_name !== input.toolName ||
    row.tool_input !== (input.toolInput ?? null)
  )
    return false;
  db.prepare("UPDATE tool_uses SET call_id = ? WHERE id = ?").run(input.callId!, row.id);
  return true;
}

/** Store a request once. Existing calls retain their payload and accumulate result evidence. */
export function storeToolUse(db: DatabaseSync, input: ToolUseInput): boolean {
  if (
    input.messageUuid &&
    db.prepare("SELECT 1 FROM memory_tombstones WHERE uuid = ?").get(input.messageUuid)
  )
    return false;
  const status = input.callId ? nativeRequestStatus(db, input) : "new";
  if (status === "missing-parent") return false;
  const inserted = status === "new";
  if (inserted) insertRequest(db, input);
  if (input.callId && input.sessionId)
    recordToolOutcome(
      db,
      input.sessionId,
      input.callId,
      toolOutcome(input.outcome),
      input.outcomeAt,
    );
  return inserted;
}

function nativeRequestStatus(
  db: DatabaseSync,
  input: ToolUseInput,
): "missing-parent" | "retained" | "new" {
  if (!input.messageUuid || !input.sessionId)
    throw new Error("A tool call requires a parent message and session");
  const parent = db
    .prepare("SELECT 1 FROM messages WHERE uuid = ? AND session_id = ?")
    .get(input.messageUuid, input.sessionId);
  if (!parent) return "missing-parent";
  const existing = db
    .prepare(
      "SELECT message_uuid, tool_name, tool_input FROM tool_uses WHERE session_id = ? AND call_id = ?",
    )
    .get(input.sessionId, input.callId!);
  if (
    existing &&
    (existing.message_uuid !== input.messageUuid ||
      existing.tool_name !== input.toolName ||
      existing.tool_input !== (input.toolInput ?? null))
  )
    throw new Error("Conflicting tool call identity");
  return existing || adoptLegacyCall(db, input) ? "retained" : "new";
}

function insertRequest(db: DatabaseSync, input: ToolUseInput): void {
  db.prepare(
    "INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input, timestamp, call_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    input.messageUuid ?? null,
    input.sessionId ?? null,
    input.toolName,
    input.toolInput ?? null,
    input.timestamp ?? null,
    input.callId ?? null,
  );
}

export function messageToolCapture(m: MessageInput): { version: number; count: number | null } {
  const version = m.toolCaptureVersion === 1 ? 1 : 0;
  const count =
    version === 1 && Number.isSafeInteger(m.toolCaptureCount) && m.toolCaptureCount! >= 0
      ? m.toolCaptureCount!
      : null;
  return { version, count };
}
