import assert from "node:assert/strict";
import { it } from "node:test";
import { appendFileSync, statSync } from "node:fs";
import { insertMessage, markFileIndexed, forgetMemory } from "./db.js";
import { fixture, meta, turn, call, result, codex } from "./tool-capture.test-support.js";

it("Codex captures native requests and later responses without changing existing message identities", (t) => {
  const f = fixture(t, "codex", [meta, turn("before"), call(), turn("after")]);
  assert.equal(f.index().toolUses, 1);
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT uuid, content FROM messages WHERE uuid IN ('codex:s:0','codex:s:1') ORDER BY uuid",
      )
      .all()
      .map((r) => [r.uuid, r.content]),
    [
      ["codex:s:0", "before"],
      ["codex:s:1", "after"],
    ],
  );
  assert.equal(f.db.prepare("SELECT outcome FROM tool_uses").get()?.outcome, "unknown");
  appendFileSync(f.file, JSON.stringify(result()) + "\n");
  assert.equal(f.index().toolUses, 0);
  assert.equal(f.db.prepare("SELECT outcome FROM tool_uses").get()?.outcome, "returned");
  assert.equal(f.index().filesSkipped, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 1);
});

it("unchanged files get parser-version backfill without duplicate turns", (t) => {
  const f = fixture(t, "codex", [meta, turn("before"), call(), result()]);
  insertMessage(f.db, { uuid: "codex:s:0", sessionId: "s", type: "assistant", content: "before" });
  const st = statSync(f.file);
  markFileIndexed(f.db, f.file, Math.floor(st.mtimeMs), st.size);
  assert.equal(f.index().filesSkipped, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 1);
  assert.equal(
    f.db.prepare("SELECT tool_capture_version v FROM messages WHERE uuid='codex:s:0'").get()?.v,
    1,
  );
});

it("unknown native events, malformed lines and orphan outputs leave capture incomplete", (t) => {
  const f = fixture(t, "codex", [
    meta,
    turn("known"),
    codex({ type: "future_tool_call", call_id: "x" }),
    result("orphan"),
  ]);
  appendFileSync(f.file, "{broken\n");
  f.index();
  assert.equal(f.db.prepare("SELECT MAX(tool_capture_version) v FROM messages").get()?.v, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 0);
});

it("custom calls retain their input and forgetting their parent prevents reindex resurrection", (t) => {
  const f = fixture(t, "codex", [
    meta,
    codex({
      type: "custom_tool_call",
      call_id: "patch",
      name: "apply_patch",
      input: "patch bytes",
    }),
    codex({ type: "custom_tool_call_output", call_id: "patch", output: "response" }),
  ]);
  f.index();
  const row = f.db.prepare("SELECT * FROM tool_uses").get();
  assert.equal(row?.tool_input, "patch bytes");
  assert.equal(row?.outcome, "returned");
  assert.equal(forgetMemory(f.db, String(row?.message_uuid)).ok, true);
  f.db.exec("DELETE FROM file_index");
  f.index();
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 0);
});

it("conflicting call identities roll back the file without marking it indexed", (t) => {
  const f = fixture(t, "codex", [
    meta,
    turn("before"),
    call(),
    codex({
      type: "function_call",
      call_id: "c",
      name: "exec_command",
      arguments: '{"cmd":"changed"}',
    }),
  ]);
  assert.throws(f.index, /conflicting tool call identity/i);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM messages").get()?.n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM file_index").get()?.n, 0);
});

it("opaque dispatch wrappers preserve the outer call without claiming nested capture", (t) => {
  const f = fixture(t, "codex", [
    meta,
    codex({
      type: "custom_tool_call",
      call_id: "dispatch",
      name: "functions.exec",
      input: "await tools.someTool({})",
    }),
    result("dispatch"),
  ]);
  assert.equal(f.index().toolUses, 1);
  assert.equal(f.db.prepare("SELECT outcome FROM tool_uses").get()?.outcome, "returned");
  assert.equal(f.db.prepare("SELECT MAX(tool_capture_version) v FROM messages").get()?.v, 0);
});

it("unsupported exec event records cannot certify zero tool calls", (t) => {
  const f = fixture(t, "codex", [
    meta,
    turn("known"),
    {
      type: "event_msg",
      payload: { type: "exec_command_begin", call_id: "exec-1", command: ["pwd"] },
    },
    { type: "event_msg", payload: { type: "exec_command_end", call_id: "exec-1", exit_code: 0 } },
  ]);
  f.index();
  assert.equal(f.db.prepare("SELECT MAX(tool_capture_version) v FROM messages").get()?.v, 0);
});
