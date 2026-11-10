import type { DatabaseSync } from "node:sqlite";
import { insertMessage, insertToolUse } from "./db.js";
import { classRank, parseMemoryClass } from "./class.js";
import { evaluateWriteGate } from "./write-gate.js";
import { assertSupportedMemorySchema } from "./db-schema.js";
import { toolOutcome } from "./tool-events.js";

type Row = Record<string, unknown>;
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export interface MergedMessages {
  messages: number;
  toolUses: number;
  scopeRepairs: number;
  protectionRepairs: number;
  tombstoneBlockedMessages: number;
}

function retainedNeedsQuarantine(row: Row, uuid: string, sessionId: string): boolean {
  if (row.quarantined) return true;
  try {
    return (
      evaluateWriteGate({ uuid, sessionId, type: str(row.type) ?? "" }, str(row.content) ?? null)
        .decision !== "allow"
    );
  } catch {
    return true;
  }
}

function preserveProtection(
  target: DatabaseSync,
  message: Row,
  uuid: string,
  sessionId: string,
): number {
  const row = target
    .prepare(
      "SELECT class, quarantined, type, content FROM messages WHERE uuid = ? AND session_id = ?",
    )
    .get(uuid, sessionId);
  if (!row) return 0;
  const incoming = parseMemoryClass(message.class).cls;
  const current = parseMemoryClass(row.class).cls;
  const cls = classRank(incoming) > classRank(current) ? incoming : current;
  const quarantined = retainedNeedsQuarantine(row, uuid, sessionId) || message.quarantined ? 1 : 0;
  if (cls === row.class && quarantined === row.quarantined) return 0;
  return Number(
    target
      .prepare("UPDATE messages SET class = ?, quarantined = ? WHERE uuid = ? AND session_id = ?")
      .run(cls, quarantined, uuid, sessionId).changes,
  );
}

function declaredCaptureCount(message: Row, nativeEvidence: boolean): number | undefined {
  const expected = num(message.tool_capture_count);
  return nativeEvidence &&
    message.tool_capture_version === 1 &&
    expected !== undefined &&
    Number.isSafeInteger(expected) &&
    expected >= 0
    ? expected
    : undefined;
}

interface ToolReconciliation {
  identities: Set<string>;
  complete: boolean;
  invalid: boolean;
  added: number;
}

function updateToolCoverage(
  target: DatabaseSync,
  message: Row,
  evidence: ToolReconciliation,
): void {
  const uuid = str(message.uuid)!;
  const sessionId = str(message.session_id)!;
  const retained = target
    .prepare("SELECT call_id, session_id FROM tool_uses WHERE message_uuid = ? ORDER BY id")
    .all(uuid);
  const unidentified = retained.some((row) => !str(row.call_id) || row.session_id !== sessionId);
  // The declared count must match the source rows and the actual retained IDs.
  // Zero is evidence only when the sender explicitly declared zero calls.
  const complete =
    evidence.complete &&
    !unidentified &&
    retained.length === evidence.identities.size &&
    retained.every((row) => evidence.identities.has(str(row.call_id)!));
  const previous = target
    .prepare("SELECT tool_capture_version, tool_capture_count FROM messages WHERE uuid = ?")
    .get(uuid);
  const previousComplete =
    previous?.tool_capture_version === 1 &&
    previous.tool_capture_count === retained.length &&
    !unidentified;
  if (complete || !previousComplete || evidence.added > 0 || unidentified || evidence.invalid) {
    const version = complete ? 1 : 0;
    const count = complete ? num(message.tool_capture_count)! : null;
    target
      .prepare(
        "UPDATE messages SET tool_capture_version = ?, tool_capture_count = ? WHERE uuid = ? AND session_id = ? AND (tool_capture_version IS NOT ? OR tool_capture_count IS NOT ?)",
      )
      .run(version, count, uuid, sessionId, version, count);
  }
}

/** Accept a tool name only when the row belongs to the parent session. */
function boundToolName(row: Row, sessionId: string): string | undefined {
  const toolSession = str(row.session_id);
  if (toolSession && toolSession !== sessionId)
    throw new Error("Conflicting tool parent/session identity");
  return toolSession ? str(row.tool_name) : undefined;
}

function mergeTools(
  target: DatabaseSync,
  message: Row,
  rows: Row[],
  nativeEvidence: boolean,
  parentAdded: boolean,
): number {
  const uuid = str(message.uuid)!;
  const sessionId = str(message.session_id)!;
  const identities = new Set<string>();
  const expected = declaredCaptureCount(message, nativeEvidence);
  let complete = expected !== undefined && expected === rows.length;
  let invalid = false;
  let added = 0;
  let ordinal = 0;
  for (const row of rows) {
    const name = boundToolName(row, sessionId);
    if (!name) {
      complete = false;
      invalid = true;
      continue;
    }
    const callId = nativeEvidence ? str(row.call_id) : undefined;
    const outcome = callId ? toolOutcome(row.outcome) : "unknown";
    if (!callId || identities.has(callId) || outcome !== row.outcome) complete = false;
    if (callId) identities.add(callId);
    const position = ordinal++;
    // Unidentified calls retain the legacy import contract. Copy every row
    // with a new parent, but do not invent identities on repeated imports.
    if (!callId && !parentAdded) continue;
    added += Number(
      insertToolUse(target, {
        messageUuid: uuid,
        sessionId,
        toolName: name,
        toolInput: typeof row.tool_input === "string" ? row.tool_input : undefined,
        timestamp: str(row.timestamp),
        callId,
        outcome,
        outcomeAt: callId ? str(row.outcome_at) : undefined,
        ordinal: position,
      }),
    );
  }
  updateToolCoverage(target, message, { identities, complete, invalid, added });
  return added;
}

function toolsByMessage(source: DatabaseSync): Map<string, Row[]> {
  const tools = new Map<string, Row[]>();
  for (const tool of source.prepare("SELECT * FROM tool_uses ORDER BY id").all()) {
    const uuid = str(tool.message_uuid);
    if (uuid) (tools.get(uuid) ?? tools.set(uuid, []).get(uuid)!).push(tool);
  }
  return tools;
}

/** Import raw evidence unchanged; only explicit local aliases change its recall scope. */
export function mergeMessages(
  target: DatabaseSync,
  source: DatabaseSync,
  mapProject: (origin: string | undefined) => string | undefined,
): MergedMessages {
  const out: MergedMessages = {
    messages: 0,
    toolUses: 0,
    scopeRepairs: 0,
    protectionRepairs: 0,
    tombstoneBlockedMessages: 0,
  };
  const nativeEvidence = (assertSupportedMemorySchema(source) ?? 0) >= 18;
  const tools = toolsByMessage(source);
  const remap = target.prepare(
    "UPDATE messages SET recall_cwd = ? WHERE uuid = ? AND session_id = ? AND cwd IS ? AND recall_cwd IS NOT ?",
  );
  const forgotten = target.prepare("SELECT 1 FROM memory_tombstones WHERE uuid = ?");
  const parent = target.prepare("SELECT session_id FROM messages WHERE uuid = ?");
  for (const message of source.prepare("SELECT * FROM messages").all()) {
    const uuid = str(message.uuid);
    const sessionId = str(message.session_id);
    const type = str(message.type);
    if (!uuid || !sessionId || !type) continue;
    if (forgotten.get(uuid)) {
      out.tombstoneBlockedMessages++;
      continue;
    }
    const existing = parent.get(uuid);
    if (existing && existing.session_id !== sessionId)
      throw new Error("Conflicting message session identity");
    const added = insertMessage(target, {
      uuid,
      sessionId,
      type,
      parentUuid: str(message.parent_uuid),
      role: str(message.role),
      content: str(message.content),
      model: str(message.model),
      inputTokens: num(message.input_tokens),
      outputTokens: num(message.output_tokens),
      cacheReadTokens: num(message.cache_read_input_tokens),
      cacheCreationTokens: num(message.cache_creation_input_tokens),
      timestamp: str(message.timestamp),
      cwd: str(message.cwd),
      gitBranch: str(message.git_branch),
      version: str(message.version),
      memoryClass: parseMemoryClass(message.class).cls,
      // Promote coverage only after the complete tool set has been reconciled.
      toolCaptureVersion: 0,
    });
    // A rejected message cannot acquire tool inputs through the duplicate path.
    if (!parent.get(uuid)) continue;
    out.protectionRepairs += preserveProtection(target, message, uuid, sessionId);
    const recallPath = mapProject(str(message.cwd));
    if (recallPath)
      out.scopeRepairs += Number(
        remap.run(recallPath, uuid, sessionId, str(message.cwd) ?? null, recallPath).changes,
      );
    if (added) out.messages++;
    out.toolUses += mergeTools(target, message, tools.get(uuid) ?? [], nativeEvidence, added);
  }
  return out;
}
