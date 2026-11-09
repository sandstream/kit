import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { forgetMemory, insertMessage, upsertSession } from "./db.js";
import {
  addCall,
  APIS,
  calls,
  captureVersion,
  complete,
  importSnapshots,
  metadataFixture,
  MODES,
  retainedState,
  seedMessage,
} from "./tool-evidence-sync.test-support.js";

for (const mode of MODES) {
  for (const api of APIS) {
    const label = `${mode}/${api}`;

    it(`${label}: a rejected parent cannot retain tool inputs through the duplicate path`, (t) => {
      const files = metadataFixture(t);
      const source = files.exportMemory(mode, "rejected", (db) => {
        addCall(db, "rejected");
        complete(db, "rejected");
        db.exec("UPDATE messages SET type = ' '");
      });
      const target = files.target();
      const result = files.importMemory(target, source.path, api);
      assert.equal(result.messages, 0);
      assert.equal(result.toolUses, 0);
      assert.deepEqual(calls(target), []);
      assert.equal(captureVersion(target, "rejected"), undefined);
    });

    for (const gap of [
      "missing",
      "unidentified",
      "invalid-outcome",
      "invalid-name",
      "unknown-count",
      "mismatched-count",
    ]) {
      it(`${label}: a capture flag cannot cover ${gap} tool evidence`, (t) => {
        const files = metadataFixture(t);
        const source = files.exportMemory(mode, "partial", (db) => {
          if (gap !== "missing") addCall(db, "partial");
          if (gap === "unidentified")
            db.exec("UPDATE tool_uses SET call_id = NULL, outcome = 'returned'");
          if (gap === "invalid-outcome") db.exec("UPDATE tool_uses SET outcome = 'unsupported'");
          if (gap === "invalid-name") db.exec("UPDATE tool_uses SET tool_name = NULL");
          complete(db, "partial", gap === "missing" ? 1 : undefined);
          if (gap === "unknown-count") db.exec("UPDATE messages SET tool_capture_count = NULL");
          if (gap === "mismatched-count") db.exec("UPDATE messages SET tool_capture_count = 2");
        });
        const target = files.target();
        files.importMemory(target, source.path, api);
        assert.equal(captureVersion(target, "partial"), 0);
        assert.equal(
          target.prepare("SELECT tool_capture_count FROM messages").get()?.tool_capture_count,
          null,
        );
        if (gap === "unidentified") assert.equal(calls(target)[0].outcome, "unknown");
        assert.equal(files.importMemory(target, source.path, api).toolUses, 0);
        assert.equal(captureVersion(target, "partial"), 0);
      });
    }

    it(`${label}: known zero-call messages retain complete capture`, (t) => {
      const files = metadataFixture(t);
      const source = files.exportMemory(mode, "result-only", (db) => {
        db.exec("UPDATE messages SET type = 'user', role = 'tool'");
        complete(db, "result-only", 0);
      });
      const target = files.target();
      files.importMemory(target, source.path, api);
      assert.deepEqual(calls(target), []);
      assert.equal(captureVersion(target, "result-only"), 1);
      assert.equal(
        target.prepare("SELECT tool_capture_count FROM messages").get()?.tool_capture_count,
        0,
      );
      files.importMemory(target, source.path, api);
      assert.equal(captureVersion(target, "result-only"), 1);
    });

    it(`${label}: unmatched retained legacy requests keep capture incomplete`, (t) => {
      const files = metadataFixture(t);
      const target = files.target();
      seedMessage(target, "partial", files.root);
      addCall(target, "partial", { callId: undefined, toolInput: "older request" });
      const source = files.exportMemory(mode, "partial", (db) => {
        addCall(db, "partial");
        complete(db, "partial");
      });
      files.importMemory(target, source.path, api);
      assert.equal(calls(target).length, 2);
      assert.equal(captureVersion(target, "partial"), 0);
      assert.equal(files.importMemory(target, source.path, api).toolUses, 0);
      assert.equal(captureVersion(target, "partial"), 0);
    });

    it(`${label}: outcome updates retain quarantine, class, raw cwd and recall alias`, (t) => {
      const files = metadataFixture(t);
      const initial = files.exportMemory(mode, "protected", (db) => {
        addCall(db, "protected");
        complete(db, "protected");
        db.exec("UPDATE messages SET quarantined = 1, class = 'restricted'");
      });
      const late = files.exportMemory(mode, "protected", (db) => {
        addCall(db, "protected", { outcome: "returned" });
        complete(db, "protected");
        db.exec("UPDATE messages SET quarantined = 0, class = 'public', cwd = '/different/source'");
      });
      const target = files.target();
      const destination = join(files.root, "local-recall");
      importSnapshots(files, target, [initial.path], api, { remapProject: destination });
      const before = target
        .prepare("SELECT class, quarantined, cwd, recall_cwd FROM messages")
        .get();
      assert.deepEqual(
        { ...before },
        {
          class: "restricted",
          quarantined: 1,
          cwd: files.root,
          recall_cwd: destination,
        },
      );
      importSnapshots(files, target, [late.path], api, { remapProject: join(files.root, "other") });
      assert.deepEqual(
        target.prepare("SELECT class, quarantined, cwd, recall_cwd FROM messages").get(),
        before,
      );
      assert.equal(calls(target)[0].outcome, "returned");
    });

    for (const conflict of ["payload", "name", "parent", "tool-session", "message-session"]) {
      it(`${label}: ${conflict} conflicts roll back the entire import`, (t) => {
        const files = metadataFixture(t);
        const target = files.target();
        seedMessage(target, "retained", files.root);
        addCall(target, "retained");
        const source = files.exportMemory(mode, "first", (db) => {
          addCall(db, "first");
          seedMessage(db, "retained", files.root);
          addCall(db, "retained", { outcome: "returned" });
          complete(db, "retained");
          db.exec(
            "UPDATE messages SET class = 'restricted', quarantined = 1 WHERE session_id = 'retained'",
          );
          if (conflict === "payload")
            db.exec(
              "UPDATE tool_uses SET tool_input = 'different request' WHERE session_id = 'retained'",
            );
          if (conflict === "name")
            db.exec("UPDATE tool_uses SET tool_name = 'Bash' WHERE session_id = 'retained'");
          if (conflict === "tool-session")
            db.exec("UPDATE tool_uses SET session_id = 'unrelated' WHERE session_id = 'retained'");
          if (conflict === "message-session")
            db.exec("UPDATE messages SET session_id = 'unrelated' WHERE uuid = 'retained-message'");
          if (conflict === "parent") {
            insertMessage(db, {
              uuid: "different-parent",
              sessionId: "retained",
              type: "assistant",
            });
            db.exec(
              "UPDATE tool_uses SET message_uuid = 'different-parent' WHERE session_id = 'retained'",
            );
          }
        });
        const earlier = files.exportMemory(mode, "earlier", (db) => addCall(db, "earlier"));
        const paths = api === "history" ? [earlier.path, source.path] : [source.path];
        const before = retainedState(target);
        assert.throws(
          () =>
            importSnapshots(files, target, paths, api, {
              remapProject: join(files.root, "remapped"),
            }),
          /Conflicting .*identity/,
        );
        assert.deepEqual(retainedState(target), before);
      });
    }

    it(`${label}: source tombstones erase calls before stale snapshots can update them`, (t) => {
      const files = metadataFixture(t);
      const stale = files.exportMemory(mode, "erased", (db) => {
        addCall(db, "erased", { outcome: "returned" });
        complete(db, "erased");
      });
      const erased = files.exportMemory(mode, "erased", (db) => {
        assert.equal(forgetMemory(db, "erased-message").ok, true);
      });
      const target = files.target();
      files.importMemory(target, stale.path, api);
      files.importMemory(target, erased.path, api);
      files.importMemory(target, stale.path, api);
      assert.deepEqual(calls(target), []);
      assert.equal(captureVersion(target, "erased"), undefined);
    });

    it(`${label}: orphan and cross-session child rows cannot attach to a retained parent`, (t) => {
      const files = metadataFixture(t);
      const source = files.exportMemory(mode, "unrelated", (db) => {
        db.prepare(
          "INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input, call_id, outcome) VALUES (?, ?, ?, ?, ?, ?)",
        ).run("local-message", "local", "Read", "orphan request", "call-1", "returned");
      });
      const target = files.target();
      upsertSession(target, { sessionId: "local", harness: "codex" });
      insertMessage(target, { uuid: "local-message", sessionId: "local", type: "assistant" });
      files.importMemory(target, source.path, api);
      assert.deepEqual(calls(target), []);
      assert.equal(captureVersion(target, "local"), 0);
    });
  }
}
