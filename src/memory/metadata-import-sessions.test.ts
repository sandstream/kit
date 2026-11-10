import assert from "node:assert/strict";
import { it } from "node:test";
import { getStats, recentMessages, searchMessages } from "./db.js";
import {
  APIS,
  INJECTION,
  metadataFixture,
  MODES,
  seedMessage,
} from "./metadata-import.test-support.js";

for (const mode of MODES) {
  for (const partial of [false, true]) {
    for (const field of [
      "session_id",
      "harness",
      "project",
      "first_message_at",
      "last_message_at",
    ]) {
      it(`${mode}: refuses session-only ${field}, partial=${partial}`, (t) => {
        const files = metadataFixture(t);
        const incoming = files.exportMemory(mode, "incoming", (db) => {
          db.exec("DELETE FROM messages");
          db.prepare(`UPDATE sessions SET ${field} = ?`).run(INJECTION);
          if (partial)
            db.exec(
              `ALTER TABLE sessions DROP COLUMN ${field === "last_message_at" ? "first_message_at" : "last_message_at"}`,
            );
        });
        for (const api of APIS) {
          const target = files.target();
          assert.throws(
            () => files.importMemory(target, incoming.path, api),
            /refusing to merge: incoming memory has .*high-confidence injection/,
            api,
          );
          assert.equal(getStats(target).sessions, 0, api);
        }
      });
    }
  }

  for (const api of APIS) {
    it(`${mode}/${api}: quarantine-only import cannot poison an existing session's origin`, (t) => {
      const files = metadataFixture(t);
      const target = files.target();
      seedMessage(target, "same-session", files.root);
      const before = recentMessages(target);
      const incoming = files.exportMemory(mode, "same-session", (db) => {
        db.prepare("UPDATE sessions SET harness = ?").run(INJECTION);
        db.exec("UPDATE messages SET uuid = 'quarantined-message', quarantined = 1");
      });

      assert.throws(
        () => files.importMemory(target, incoming.path, api),
        /refusing to merge: incoming memory has .*high-confidence injection/,
      );
      assert.deepEqual(recentMessages(target), before);
      assert.deepEqual(searchMessages(target, "metadatarecall"), before);
      assert.deepEqual(getStats(target).byHarness, [{ harness: "codex", sessions: 1 }]);
    });
  }
}
