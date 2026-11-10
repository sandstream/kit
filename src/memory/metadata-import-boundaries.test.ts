import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import {
  countQuarantined,
  getStats,
  insertMessage,
  insertToolUse,
  recentMessages,
  searchMessages,
} from "./db.js";
import { syncFromExports } from "./sync.js";
import {
  APIS,
  INJECTION,
  metadataFixture,
  MODES,
  seedMessage,
} from "./metadata-import.test-support.js";

for (const mode of MODES) {
  for (const table of ["sessions", "messages"]) {
    it(`${mode}: history refuses ${table} metadata and rolls back every snapshot`, (t) => {
      const files = metadataFixture(t);
      const target = files.target();
      seedMessage(target, "existing", files.root);
      const before = recentMessages(target);
      const beforeStats = getStats(target);
      const first = files.exportMemory(mode, "new-session");
      const poisoned = files.exportMemory(mode, "existing", (db) => {
        db.exec("UPDATE messages SET uuid = 'quarantined-new', quarantined = 1");
        db.prepare(
          table === "sessions"
            ? "UPDATE sessions SET harness = ?"
            : "UPDATE messages SET model = ?",
        ).run(INJECTION);
      });
      // A later clean session snapshot cannot erase an earlier source finding.
      const last = files.exportMemory(mode, "existing");
      assert.throws(
        () =>
          syncFromExports(target, [first.path, poisoned.path, last.path], {
            passphrase: files.passphrase,
          }),
        /refusing to merge: incoming memory has .*high-confidence injection/,
      );
      assert.deepEqual(recentMessages(target), before);
      assert.deepEqual(
        searchMessages(target, "metadatarecall", { includeQuarantined: true }),
        before,
      );
      assert.deepEqual(getStats(target), beforeStats);
    });
  }

  for (const partial of [false, true]) {
    it(`${mode}: benign metadata and sender-quarantined archive survive, partial=${partial}`, (t) => {
      const files = metadataFixture(t);
      const archived = "metadatarecall sender retained this private note";
      const incoming = files.exportMemory(mode, "incoming", (db) => {
        insertMessage(db, {
          uuid: "flagged-message",
          sessionId: "incoming",
          type: "assistant",
          role: "assistant",
          content: archived,
          cwd: files.root,
          gitBranch: "original-branch",
          timestamp: "2026-02-01T00:00:00Z",
          model: "archive-model",
          inputTokens: 2,
        });
        db.exec("UPDATE messages SET quarantined = 1 WHERE uuid = 'flagged-message'");
        if (partial) {
          db.exec("ALTER TABLE messages DROP COLUMN role");
          db.exec("ALTER TABLE sessions DROP COLUMN last_message_at");
        }
      });
      const sourceBefore = readFileSync(incoming.sourcePath);
      const encryptedBefore = readFileSync(incoming.path);
      for (const api of APIS) {
        const target = files.target();
        assert.equal(files.importMemory(target, incoming.path, api).messages, 2);
        assert.equal(countQuarantined(target), 1);
        const live = searchMessages(target, "metadatarecall");
        assert.deepEqual(
          live.map((hit) => hit.uuid),
          ["incoming-message"],
        );
        assert.deepEqual(recentMessages(target), live);
        const archive = searchMessages(target, "metadatarecall", { includeQuarantined: true });
        assert.equal(archive.length, 2);
        const flagged = archive.find((hit) => hit.uuid === "flagged-message");
        assert.ok(flagged);
        assert.equal(flagged.content, archived);
        assert.equal(flagged.harness, "codex");
        assert.equal(flagged.cwd, files.root);
        assert.equal(flagged.gitBranch, "original-branch");
        assert.equal(flagged.timestamp, "2026-02-01T00:00:00Z");
        assert.deepEqual(getStats(target).tokens.byModel, [
          { model: "archive-model", messages: 1, inputTokens: 2, outputTokens: 0 },
          { model: "synthetic-model", messages: 1, inputTokens: 1, outputTokens: 0 },
        ]);
      }
      assert.deepEqual(readFileSync(incoming.sourcePath), sourceBefore);
      assert.deepEqual(readFileSync(incoming.path), encryptedBefore);
    });
  }

  it(`${mode}: fields without recall readers remain unchanged in the archive`, (t) => {
    const files = metadataFixture(t);
    const incoming = files.exportMemory(mode, "incoming", (db) => {
      db.prepare("UPDATE messages SET parent_uuid = ?, type = ?, version = ?").run(
        INJECTION,
        INJECTION,
        INJECTION,
      );
    });
    for (const api of APIS) {
      const target = files.target();
      files.importMemory(target, incoming.path, api);
      const row = target.prepare("SELECT parent_uuid, type, version FROM messages").get();
      assert.deepEqual({ ...row }, { parent_uuid: INJECTION, type: INJECTION, version: INJECTION });
      assert.equal(recentMessages(target).length, 1);
      assert.ok(!JSON.stringify(searchMessages(target, "metadatarecall")).includes(INJECTION));
    }
  });

  for (const quarantined of [false, true]) {
    for (const missing of [undefined, "cwd", "quarantined"]) {
      it(`${mode}: content authentication remains bounded, quarantine=${quarantined}, missing=${missing}`, (t) => {
        const files = metadataFixture(t);
        const incoming = files.exportMemory(mode, "incoming", (db) => {
          db.prepare("UPDATE messages SET content = ?, quarantined = ?").run(
            INJECTION,
            Number(quarantined),
          );
          if (missing) db.exec(`ALTER TABLE messages DROP COLUMN ${missing}`);
        });
        for (const api of APIS) {
          const target = files.target();
          if (mode === "passphrase" && quarantined && !missing) {
            files.importMemory(target, incoming.path, api);
            assert.equal(countQuarantined(target), 1);
            assert.deepEqual(recentMessages(target), []);
            assert.equal(
              searchMessages(target, "METADATA_IMPORT_MARKER", { includeQuarantined: true })[0]
                ?.content,
              INJECTION,
            );
          } else {
            assert.throws(
              () => files.importMemory(target, incoming.path, api),
              /refusing to merge: incoming memory has .*high-confidence injection/,
            );
            assert.equal(getStats(target).messages, 0);
          }
        }
      });
    }
  }

  it(`${mode}: tool-input archive exemption keeps its existing authentication boundary`, (t) => {
    const files = metadataFixture(t);
    const incoming = files.exportMemory(mode, "incoming", (db) => {
      insertToolUse(db, {
        messageUuid: "incoming-message",
        sessionId: "incoming",
        toolName: "Bash",
        toolInput: INJECTION,
      });
    });
    for (const api of APIS) {
      const target = files.target();
      if (mode === "passphrase") {
        assert.equal(files.importMemory(target, incoming.path, api).toolUses, 1);
        assert.equal(
          target.prepare("SELECT tool_input FROM tool_uses").get()?.tool_input,
          INJECTION,
        );
      } else {
        assert.throws(() => files.importMemory(target, incoming.path, api), /refusing to merge/);
      }
    }
    const source = new DatabaseSync(incoming.sourcePath, { readOnly: true });
    try {
      assert.equal(source.prepare("SELECT tool_input FROM tool_uses").get()?.tool_input, INJECTION);
    } finally {
      source.close();
    }
  });
}
