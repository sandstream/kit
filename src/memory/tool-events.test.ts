import assert from "node:assert/strict";
import { it } from "node:test";
import { forgetMemory, insertMessage, insertToolUse, openMemoryDb } from "./db.js";
import { mergeToolOutcome, recordToolOutcome } from "./tool-events.js";

it("tool results merge without turning an unknown request into execution evidence", () => {
  assert.equal(mergeToolOutcome("unknown", "unknown"), "unknown");
  assert.equal(mergeToolOutcome("unknown", "returned"), "returned");
  assert.equal(mergeToolOutcome("error", "denied"), "denied");
  assert.equal(mergeToolOutcome("returned", "error"), "conflict");
  assert.equal(mergeToolOutcome("denied", "returned"), "conflict");
  assert.equal(mergeToolOutcome("conflict", "returned"), "conflict");
});

it("a captured call gains a later result once and retains its original request", (t) => {
  const db = openMemoryDb(":memory:");
  t.after(() => db.close());
  insertMessage(db, { uuid: "m1", sessionId: "s1", type: "assistant", content: "tool request" });
  const call = {
    messageUuid: "m1",
    sessionId: "s1",
    callId: "call-1",
    toolName: "Read",
    toolInput: '{"path":"one"}',
  };
  assert.equal(insertToolUse(db, call), true);
  assert.equal(insertToolUse(db, call), false);
  assert.equal(db.prepare("SELECT outcome FROM tool_uses").get()?.outcome, "unknown");
  assert.equal(recordToolOutcome(db, "s1", "call-1", "returned", "2026-01-01"), true);
  assert.equal(recordToolOutcome(db, "s1", "call-1", "returned", "2026-01-01"), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 1);
  assert.equal(db.prepare("SELECT tool_input FROM tool_uses").get()?.tool_input, call.toolInput);
  assert.equal(recordToolOutcome(db, "other", "call-1", "denied"), false);
  assert.equal(recordToolOutcome(db, "s1", "call-1", "error"), true);
  assert.equal(db.prepare("SELECT outcome FROM tool_uses").get()?.outcome, "conflict");
});

it("reindex upgrades matching legacy calls without duplicating identical requests", (t) => {
  const db = openMemoryDb(":memory:");
  t.after(() => db.close());
  insertMessage(db, { uuid: "m1", sessionId: "s1", type: "assistant" });
  const legacy = { messageUuid: "m1", sessionId: "s1", toolName: "Read", toolInput: "{}" };
  insertToolUse(db, legacy);
  insertToolUse(db, legacy);
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    assert.equal(insertToolUse(db, { ...legacy, callId: `call-${ordinal}`, ordinal }), false);
  }
  assert.deepEqual(
    db
      .prepare("SELECT call_id, outcome FROM tool_uses ORDER BY id")
      .all()
      .map((r) => [r.call_id, r.outcome]),
    [
      ["call-0", "unknown"],
      ["call-1", "unknown"],
    ],
  );
});

it("forget removes linked calls and later capture cannot revive their tool input", (t) => {
  const db = openMemoryDb(":memory:");
  t.after(() => db.close());
  insertMessage(db, { uuid: "m1", sessionId: "s1", type: "assistant", content: "private history" });
  const call = {
    messageUuid: "m1",
    sessionId: "s1",
    callId: "call-1",
    toolName: "Read",
    toolInput: "private argument",
  };
  insertToolUse(db, call);
  assert.equal(forgetMemory(db, "m1").ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 0);
  assert.equal(insertToolUse(db, { ...call, callId: undefined }), false);
  assert.equal(insertToolUse(db, call), false);
  assert.equal(recordToolOutcome(db, "s1", "call-1", "returned"), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 0);
});
