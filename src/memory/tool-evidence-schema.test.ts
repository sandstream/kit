import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import {
  insertMessage,
  insertToolUse,
  openMemoryDb,
  openMemoryDbReadOnly,
  SCHEMA_VERSION,
} from "./db.js";
import { fixture } from "./backup.test-support.js";

function legacyStore(path: string): void {
  const db = openMemoryDb(path);
  insertMessage(db, { uuid: "kept", sessionId: "s", type: "assistant", content: "kept message" });
  insertToolUse(db, {
    messageUuid: "kept",
    sessionId: "s",
    toolName: "Read",
    toolInput: "kept request",
  });
  db.exec(`DROP INDEX idx_tool_call_identity;
    DROP TRIGGER messages_tools_ad;
    ALTER TABLE tool_uses DROP COLUMN call_id;
    ALTER TABLE tool_uses DROP COLUMN outcome;
    ALTER TABLE tool_uses DROP COLUMN outcome_at;
    ALTER TABLE messages DROP COLUMN tool_capture_version;
    ALTER TABLE messages DROP COLUMN tool_capture_count;
    ALTER TABLE file_index DROP COLUMN parser_version;
    INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input) VALUES ('forgotten', 's', 'Read', 'forgotten input');
    INSERT INTO memory_tombstones (uuid, content_sha256, deleted_at) VALUES ('forgotten', 'digest', '2026-01-01');
    UPDATE schema_meta SET version = 17;
    PRAGMA journal_mode=DELETE`);
  db.close();
}

it("schema 17 stays unchanged on read and migrates legacy evidence to unknown on explicit writable open", (t) => {
  const { src } = fixture(t);
  legacyStore(src);
  const before = readFileSync(src);
  const readonly = openMemoryDbReadOnly(src);
  assert.equal(readonly.prepare("SELECT version FROM schema_meta").get()?.version, 17);
  readonly.close();
  assert.deepEqual(readFileSync(src), before);
  const migrated = openMemoryDb(src);
  assert.equal(migrated.prepare("SELECT version FROM schema_meta").get()?.version, SCHEMA_VERSION);
  assert.deepEqual(
    migrated
      .prepare("SELECT tool_input, call_id, outcome FROM tool_uses")
      .all()
      .map((r) => [r.tool_input, r.call_id, r.outcome]),
    [["kept request", null, "unknown"]],
  );
  assert.equal(
    migrated.prepare("SELECT tool_capture_version v FROM messages WHERE uuid='kept'").get()?.v,
    0,
  );
  migrated.close();
  const again = openMemoryDb(src);
  assert.equal(again.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 1);
  again.close();
});

it("a declared evidence-aware store cannot silently replace missing evidence columns", (t) => {
  const { src } = fixture(t);
  const db = openMemoryDb(src);
  db.exec("ALTER TABLE tool_uses DROP COLUMN outcome; PRAGMA journal_mode=DELETE");
  db.close();
  const before = readFileSync(src);
  for (const open of [openMemoryDb, openMemoryDbReadOnly]) {
    assert.throws(() => open(src), /tool evidence storage is missing/i);
    assert.deepEqual(readFileSync(src), before);
  }
});
