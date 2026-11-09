import type { DatabaseSync } from "node:sqlite";
import { insertToolUse } from "./db.js";
import { recordToolOutcome, type ToolOutcome } from "./tool-events.js";
import type { ToolUseInput } from "./types.js";

export const TOOL_CAPTURE_VERSION = 1;
type PendingResult = {
  sessionId: string;
  callId: string;
  outcome: ToolOutcome;
  timestamp?: string;
};

/** Collect native evidence before marking the retained messages as covered. */
export class TranscriptTools {
  complete = true;
  retry = false;
  added = 0;
  private messages = new Map<string, string>();
  private calls = new Map<string, Set<string>>();
  private results: PendingResult[] = [];

  constructor(private db: DatabaseSync) {}

  message(uuid: string, sessionId: string): void {
    this.messages.set(uuid, sessionId);
  }

  call(input: ToolUseInput, parentAdded: boolean): void {
    if (!input.callId) {
      this.complete = false;
      if (!parentAdded) return;
    }
    if (input.callId && input.messageUuid) {
      const calls = this.calls.get(input.messageUuid) ?? new Set<string>();
      calls.add(input.callId);
      this.calls.set(input.messageUuid, calls);
    }
    if (insertToolUse(this.db, input)) this.added++;
  }

  result(sessionId: string, callId: unknown, outcome: ToolOutcome, timestamp?: string): void {
    if (typeof callId !== "string" || !callId) {
      this.complete = false;
      return;
    }
    this.results.push({ sessionId, callId, outcome, timestamp });
  }

  finish(): void {
    for (const r of this.results) {
      const call = this.db
        .prepare("SELECT 1 FROM tool_uses WHERE session_id = ? AND call_id = ?")
        .get(r.sessionId, r.callId);
      if (!call) {
        this.complete = false;
        this.retry = true;
      } else recordToolOutcome(this.db, r.sessionId, r.callId, r.outcome, r.timestamp);
    }
    const retained = this.db.prepare(
      "SELECT call_id, session_id FROM tool_uses WHERE message_uuid = ?",
    );
    for (const [uuid, sessionId] of this.messages) {
      const calls = this.calls.get(uuid) ?? new Set<string>();
      const rows = retained.all(uuid);
      if (
        rows.length !== calls.size ||
        rows.some((row) => row.session_id !== sessionId || !calls.has(String(row.call_id)))
      )
        this.complete = false;
    }
    const update = this.db.prepare(
      "UPDATE messages SET tool_capture_version = ?, tool_capture_count = ? WHERE uuid = ? AND session_id = ? AND (tool_capture_version != ? OR tool_capture_count IS NOT ?)",
    );
    const version = this.complete ? TOOL_CAPTURE_VERSION : 0;
    for (const [uuid, sessionId] of this.messages) {
      const expected = this.complete ? (this.calls.get(uuid)?.size ?? 0) : null;
      update.run(version, expected, uuid, sessionId, version, expected);
    }
  }
}

/** Use a savepoint so call identity failures cannot leave partial capture or coverage. */
export function captureTranscript<T extends object>(
  db: DatabaseSync,
  capture: (tools: TranscriptTools) => T,
): T & { retry: boolean } {
  db.exec("SAVEPOINT transcript_tool_capture");
  try {
    const tools = new TranscriptTools(db);
    const result = capture(tools);
    tools.finish();
    db.exec("RELEASE transcript_tool_capture");
    return { ...result, retry: tools.retry };
  } catch (error) {
    db.exec("ROLLBACK TO transcript_tool_capture; RELEASE transcript_tool_capture");
    throw error;
  }
}

/** Native error flags describe a failed response, not a proven authorization denial. */
export function nativeToolOutcome(value: Record<string, unknown>): ToolOutcome {
  if (value.is_error === true || value.isError === true) return "error";
  const output = value.output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const obj = output as Record<string, unknown>;
    if (obj.is_error === true || obj.isError === true) return "error";
  }
  return "returned";
}

/** Decode JSON objects only. An unrecognized line makes coverage incomplete. */
export function transcriptRecord(
  line: string,
  tools: TranscriptTools,
): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* The raw transcript remains the source for a later parser. */
  }
  tools.complete = false;
  return undefined;
}
