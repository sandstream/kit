import assert from "node:assert/strict";
import { it } from "node:test";
import { forgetMemory } from "./db.js";
import {
  addCall,
  APIS,
  calls,
  captureVersion,
  complete,
  legacy17,
  metadataFixture,
  MODES,
  seedMessage,
} from "./tool-evidence-sync.test-support.js";

for (const mode of MODES) {
  for (const api of APIS) {
    const label = `${mode}/${api}`;

    it(`${label}: preserves empty native request bytes across repeated import`, (t) => {
      const files = metadataFixture(t);
      const source = files.exportMemory(mode, "empty-request", (db) => {
        addCall(db, "empty-request", { toolInput: "", outcome: "returned" });
        complete(db, "empty-request");
      });
      const target = files.target();
      files.importMemory(target, source.path, api);
      assert.equal(calls(target)[0].tool_input, "");
      assert.equal(captureVersion(target, "empty-request"), 1);
      assert.equal(files.importMemory(target, source.path, api).toolUses, 0);
      assert.equal(calls(target)[0].outcome, "returned");
    });

    it(`${label}: preserves native calls, outcomes and coverage on repeated import`, (t) => {
      const files = metadataFixture(t);
      const source = files.exportMemory(mode, "native", (db) => {
        addCall(db, "native", { outcome: "returned", outcomeAt: "2026-01-02T00:01:00Z" });
        complete(db, "native");
      });
      const target = files.target();
      assert.equal(files.importMemory(target, source.path, api).toolUses, 1);
      assert.equal(captureVersion(target, "native"), 1);
      assert.deepEqual(calls(target), [
        {
          message_uuid: "native-message",
          session_id: "native",
          tool_name: "Read",
          tool_input: '{"path":"fixture.txt"}',
          call_id: "call-1",
          outcome: "returned",
          outcome_at: "2026-01-02T00:01:00Z",
        },
      ]);
      const before = calls(target);
      const repeated = files.importMemory(target, source.path, api);
      assert.equal(repeated.messages, 0);
      assert.equal(repeated.toolUses, 0);
      assert.deepEqual(calls(target), before);
    });

    it(`${label}: imports calls for retained parents and merges late results`, (t) => {
      const files = metadataFixture(t);
      const parent = files.exportMemory(mode, "late");
      const request = files.exportMemory(mode, "late", (db) => {
        addCall(db, "late");
        complete(db, "late");
      });
      const result = files.exportMemory(mode, "late", (db) => {
        addCall(db, "late", { outcome: "returned", outcomeAt: "2026-01-02T00:01:00Z" });
        complete(db, "late");
      });
      const target = files.target();
      files.importMemory(target, parent.path, api);
      assert.equal(captureVersion(target, "late"), 0);
      const added = files.importMemory(target, request.path, api);
      assert.equal(added.messages, 0);
      assert.equal(added.toolUses, 1);
      assert.equal(captureVersion(target, "late"), 1);
      assert.equal(calls(target)[0].outcome, "unknown");
      assert.equal(files.importMemory(target, result.path, api).toolUses, 0);
      assert.equal(calls(target)[0].outcome, "returned");
      assert.equal(files.importMemory(target, request.path, api).toolUses, 0);
      assert.equal(calls(target)[0].outcome, "returned");
      assert.equal(calls(target)[0].outcome_at, "2026-01-02T00:01:00Z");
    });

    it(`${label}: keeps contradictory outcomes visible as conflict`, (t) => {
      const files = metadataFixture(t);
      const paths = (["returned", "error", "denied"] as const).map(
        (outcome, index) =>
          files.exportMemory(mode, "contradiction", (db) => {
            addCall(db, "contradiction", { outcome, outcomeAt: `2026-01-02T00:0${index}:00Z` });
            complete(db, "contradiction");
          }).path,
      );
      const target = files.target();
      for (const path of [...paths, paths[0]]) files.importMemory(target, path, api);
      assert.equal(calls(target).length, 1);
      assert.equal(calls(target)[0].outcome, "conflict");
      assert.equal(calls(target)[0].outcome_at, "2026-01-02T00:02:00Z");
    });

    it(`${label}: legacy 17 stays unknown and native recapture adopts by ordinal`, (t) => {
      const files = metadataFixture(t);
      const legacy = files.exportMemory(mode, "legacy", (db) => {
        addCall(db, "legacy", { callId: undefined });
        addCall(db, "legacy", { callId: undefined });
        legacy17(db);
      });
      const native = files.exportMemory(mode, "legacy", (db) => {
        for (let ordinal = 0; ordinal < 2; ordinal++)
          addCall(db, "legacy", { callId: `call-${ordinal}`, outcome: "returned" });
        complete(db, "legacy");
      });
      const target = files.target();
      assert.equal(files.importMemory(target, legacy.path, api).toolUses, 2);
      assert.deepEqual(
        calls(target).map((row) => [row.call_id, row.outcome]),
        [
          [null, "unknown"],
          [null, "unknown"],
        ],
      );
      assert.equal(captureVersion(target, "legacy"), 0);
      assert.equal(files.importMemory(target, legacy.path, api).toolUses, 0);
      assert.equal(calls(target).length, 2);
      assert.equal(files.importMemory(target, native.path, api).toolUses, 0);
      assert.deepEqual(
        calls(target).map((row) => [row.call_id, row.outcome]),
        [
          ["call-0", "returned"],
          ["call-1", "returned"],
        ],
      );
      assert.equal(captureVersion(target, "legacy"), 1);
      assert.equal(files.importMemory(target, legacy.path, api).toolUses, 0);
      assert.equal(calls(target).length, 2);
      assert.equal(captureVersion(target, "legacy"), 1);
    });

    it(`${label}: call identifiers remain scoped to their sessions`, (t) => {
      const files = metadataFixture(t);
      const source = files.exportMemory(mode, "first", (db) => {
        seedMessage(db, "second", files.root);
        addCall(db, "first", { outcome: "returned" });
        addCall(db, "second", { outcome: "denied" });
      });
      const target = files.target();
      assert.equal(files.importMemory(target, source.path, api).toolUses, 2);
      assert.deepEqual(
        calls(target).map((row) => [row.session_id, row.call_id, row.outcome]),
        [
          ["first", "call-1", "returned"],
          ["second", "call-1", "denied"],
        ],
      );
    });

    it(`${label}: late outcomes cannot resurrect forgotten parents or tool inputs`, (t) => {
      const files = metadataFixture(t);
      const source = files.exportMemory(mode, "forgotten", (db) => {
        addCall(db, "forgotten", { outcome: "returned" });
        complete(db, "forgotten");
      });
      const target = files.target();
      files.importMemory(target, source.path, api);
      assert.equal(forgetMemory(target, "forgotten-message").ok, true);
      const replay = files.importMemory(target, source.path, api);
      assert.equal(replay.tombstoneBlockedMessages, 1);
      assert.equal(replay.toolUses, 0);
      assert.deepEqual(calls(target), []);
      assert.equal(captureVersion(target, "forgotten"), undefined);
    });
  }
}
