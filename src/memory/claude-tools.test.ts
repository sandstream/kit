import assert from "node:assert/strict";
import { it } from "node:test";
import { statSync } from "node:fs";
import { insertMessage, markFileIndexed } from "./db.js";
import { fixture } from "./tool-capture.test-support.js";

it("Claude joins calls to native results and does not classify an error as a gate denial", (t) => {
  const f = fixture(t, "claude", [
    {
      type: "assistant",
      uuid: "a",
      sessionId: "s",
      message: { content: [{ type: "tool_use", id: "c", name: "Read", input: { path: "one" } }] },
    },
    {
      type: "user",
      uuid: "b",
      sessionId: "s",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "c", is_error: true, content: "permission denied" },
        ],
      },
    },
  ]);
  assert.equal(f.index().toolUses, 1);
  assert.deepEqual(
    f.db
      .prepare("SELECT call_id, outcome FROM tool_uses")
      .all()
      .map((r) => [r.call_id, r.outcome]),
    [["c", "error"]],
  );
  assert.equal(f.db.prepare("SELECT MIN(tool_capture_version) v FROM messages").get()?.v, 1);
});

it("Claude parser-version backfill adopts legacy calls without repeating them", (t) => {
  const f = fixture(t, "claude", [
    {
      type: "assistant",
      uuid: "a",
      sessionId: "s",
      message: { content: [{ type: "tool_use", id: "c", name: "Read", input: {} }] },
    },
    {
      type: "user",
      uuid: "b",
      sessionId: "s",
      message: { content: [{ type: "tool_result", tool_use_id: "c", content: "response" }] },
    },
  ]);
  insertMessage(f.db, { uuid: "a", sessionId: "s", type: "assistant" });
  f.db.exec(
    "INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input) VALUES ('a','s','Read','{}')",
  );
  const st = statSync(f.file);
  markFileIndexed(f.db, f.file, Math.floor(st.mtimeMs), st.size);
  assert.equal(f.index().toolUses, 0);
  assert.deepEqual(
    f.db
      .prepare("SELECT call_id, outcome FROM tool_uses")
      .all()
      .map((r) => [r.call_id, r.outcome]),
    [["c", "returned"]],
  );
});
