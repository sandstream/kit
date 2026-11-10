import type { ToolUseInput } from "./types.js";
import { insertToolUse } from "./db.js";
import { metadataFixture, type ImportApi, type MemoryDb } from "./metadata-import.test-support.js";
import { syncFromExport, syncFromExports, type SyncOptions } from "./sync.js";

export { APIS, MODES, metadataFixture, seedMessage } from "./metadata-import.test-support.js";

export function addCall(
  db: MemoryDb,
  sessionId: string,
  options: Partial<ToolUseInput> = {},
): void {
  insertToolUse(db, {
    messageUuid: `${sessionId}-message`,
    sessionId,
    toolName: "Read",
    toolInput: '{"path":"fixture.txt"}',
    timestamp: "2026-01-02T00:00:00Z",
    callId: "call-1",
    outcome: "unknown",
    ...options,
  });
}

export function complete(db: MemoryDb, sessionId: string, expectedCount?: number): void {
  const count =
    expectedCount ??
    Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE message_uuid = ? AND session_id = ?")
        .get(`${sessionId}-message`, sessionId)?.n,
    );
  db.prepare(
    "UPDATE messages SET tool_capture_version = 1, tool_capture_count = ? WHERE uuid = ?",
  ).run(count, `${sessionId}-message`);
}

export function legacy17(db: MemoryDb): void {
  db.exec(`
    DROP INDEX idx_tool_call_identity;
    ALTER TABLE tool_uses DROP COLUMN call_id;
    ALTER TABLE tool_uses DROP COLUMN outcome;
    ALTER TABLE tool_uses DROP COLUMN outcome_at;
    ALTER TABLE messages DROP COLUMN tool_capture_version;
    ALTER TABLE messages DROP COLUMN tool_capture_count;
    ALTER TABLE file_index DROP COLUMN parser_version;
    UPDATE schema_meta SET version = 17;
  `);
}

export function calls(db: MemoryDb) {
  return db
    .prepare(
      "SELECT message_uuid, session_id, tool_name, tool_input, call_id, outcome, outcome_at FROM tool_uses ORDER BY id",
    )
    .all()
    .map((row) => ({ ...row }));
}

export function captureVersion(db: MemoryDb, sessionId: string): unknown {
  return db
    .prepare("SELECT tool_capture_version FROM messages WHERE uuid = ?")
    .get(`${sessionId}-message`)?.tool_capture_version;
}

export function retainedState(db: MemoryDb) {
  return ["sessions", "messages", "tool_uses", "memory_tombstones", "memory_projects"].map(
    (table) => db.prepare(`SELECT * FROM ${table}`).all(),
  );
}

export function importSnapshots(
  files: ReturnType<typeof metadataFixture>,
  target: MemoryDb,
  paths: string[],
  api: ImportApi,
  options: SyncOptions = {},
) {
  const opts = { passphrase: files.passphrase, ...options };
  return api === "history"
    ? syncFromExports(target, paths, opts)
    : syncFromExport(target, paths[0], opts);
}
