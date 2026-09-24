import type { DatabaseSync } from "node:sqlite";
import { insertMessage, insertToolUse } from "./db.js";
import { classRank, parseMemoryClass } from "./class.js";
import { evaluateWriteGate } from "./write-gate.js";

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
  const tools = new Map<string, Row[]>();
  for (const tool of source.prepare("SELECT * FROM tool_uses").all()) {
    const uuid = str(tool.message_uuid);
    if (uuid) (tools.get(uuid) ?? tools.set(uuid, []).get(uuid)!).push(tool);
  }
  const remap = target.prepare(
    "UPDATE messages SET recall_cwd = ? WHERE uuid = ? AND session_id = ? AND cwd IS ? AND recall_cwd IS NOT ?",
  );
  const forgotten = target.prepare("SELECT 1 FROM memory_tombstones WHERE uuid = ?");
  for (const message of source.prepare("SELECT * FROM messages").all()) {
    const uuid = str(message.uuid);
    const sessionId = str(message.session_id);
    const type = str(message.type);
    if (!uuid || !sessionId || !type) continue;
    if (forgotten.get(uuid)) {
      out.tombstoneBlockedMessages++;
      continue;
    }
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
    });
    out.protectionRepairs += preserveProtection(target, message, uuid, sessionId);
    const recallPath = mapProject(str(message.cwd));
    if (recallPath)
      out.scopeRepairs += Number(
        remap.run(recallPath, uuid, sessionId, str(message.cwd) ?? null, recallPath).changes,
      );
    if (!added) continue;
    out.messages++;
    for (const tool of tools.get(uuid) ?? []) {
      insertToolUse(target, {
        messageUuid: uuid,
        sessionId: str(tool.session_id),
        toolName: str(tool.tool_name) ?? "unknown",
        toolInput: str(tool.tool_input),
        timestamp: str(tool.timestamp),
      });
      out.toolUses++;
    }
  }
  return out;
}
