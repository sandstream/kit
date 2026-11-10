import assert from "node:assert/strict";
import { it } from "node:test";
import { recentMessages, searchMessages, upsertSession } from "./db.js";
import { getThread, resumeCommandsForThread, saveThread } from "./threads.js";
import { APIS, metadataFixture, MODES, seedMessage } from "./metadata-import.test-support.js";

for (const mode of MODES) {
  for (const missing of ["column", "empty", "null", "unknown"]) {
    for (const existing of ["codex", "claude-code", undefined]) {
      it(`${mode}: ${missing} harness preserves ${existing ?? "unknown origin"}`, (t) => {
        const files = metadataFixture(t);
        const incoming = files.exportMemory(mode, "same-session", (db) => {
          saveThread(db, { name: "saved", sessionId: "same-session", projectPath: files.root });
          if (missing === "column" || missing === "null") {
            db.exec("ALTER TABLE sessions DROP COLUMN harness");
            if (missing === "null") db.exec("ALTER TABLE sessions ADD COLUMN harness TEXT");
          } else {
            db.prepare("UPDATE sessions SET harness = ?").run(missing === "empty" ? "" : "unknown");
          }
        });
        for (const api of APIS) {
          const target = files.target();
          if (existing) {
            seedMessage(target, "same-session", files.root);
            upsertSession(target, { sessionId: "same-session", harness: existing });
          }
          const result = files.importMemory(target, incoming.path, api);
          assert.equal(result.messages, existing ? 0 : 1);
          const expected = existing ?? "unknown";
          assert.equal(recentMessages(target)[0]?.harness, expected, api);
          assert.equal(searchMessages(target, "metadatarecall")[0]?.harness, expected, api);
          const thread = getThread(target, "saved");
          assert.ok(thread);
          assert.equal(thread.harness, expected, api);
          assert.deepEqual(
            resumeCommandsForThread(thread),
            existing === "codex"
              ? ["codex resume same-session"]
              : existing === "claude-code"
                ? ["claude --resume same-session"]
                : [],
            api,
          );
        }
      });
    }
  }

  it(`${mode}: explicit incoming producer remains available to recall and resume`, (t) => {
    const files = metadataFixture(t);
    const incoming = files.exportMemory(mode, "same-session", (db) => {
      upsertSession(db, { sessionId: "same-session", harness: "claude-code" });
    });
    for (const api of APIS) {
      const target = files.target();
      seedMessage(target, "same-session", files.root);
      files.importMemory(target, incoming.path, api);
      assert.equal(recentMessages(target)[0]?.harness, "claude-code", api);
    }
  });
}
