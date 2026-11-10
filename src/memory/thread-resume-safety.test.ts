import assert from "node:assert/strict";
import { it } from "node:test";
import { resumeCommandsForThread, type SavedThread } from "./threads.js";
import { fixture } from "./pal-cli.test-support.js";

const thread: SavedThread = {
  name: "saved history",
  session_id: "session-1",
  summary: null,
  project_path: "/repo",
  saved_at: "2026-01-01",
  harness: "codex",
};

it("does not turn stored identifiers into shell syntax or command options", () => {
  for (const harness of ["codex", "claude-code", null]) {
    for (const session_id of [
      "session; printf resumeprobe",
      "$(printf resumeprobe)",
      "`printf resumeprobe`",
      "session\nother-command",
      "session & other-command",
      "session|other-command",
      "session > output",
      "%RESUME_PROBE%",
      "--help",
      "",
    ]) {
      assert.deepEqual(resumeCommandsForThread({ ...thread, harness, session_id }), [], session_id);
    }
  }
});

it("retains native resume commands for normal opaque session identifiers", () => {
  const session_id = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(resumeCommandsForThread({ ...thread, harness: "codex", session_id }), [
    `codex resume ${session_id}`,
  ]);
  assert.deepEqual(resumeCommandsForThread({ ...thread, harness: "claude-code", session_id }), [
    `claude --resume ${session_id}`,
  ]);
  assert.deepEqual(resumeCommandsForThread({ ...thread, harness: null, session_id: "session_1" }), [
    "claude --resume session_1",
    "codex resume session_1",
  ]);
});

it("CLI keeps the original identifier but explains why no runnable command is available", async (t) => {
  const { memory } = await fixture(t);
  const sessionId = "session; printf resumeprobe";
  await memory("save", "archive", `--session=${sessionId}`);
  const output = await memory("resume", "archive");
  assert.match(output, /no safe live-resume command/i);
  assert.doesNotMatch(output, /claude --resume|codex resume/);
  const saved = JSON.parse(await memory("threads", "--json"));
  assert.equal(saved[0].session_id, sessionId);
});

it("CLI does not format a multiline bookmark name as another resume command", async (t) => {
  const { memory } = await fixture(t);
  const name = "archive\n  codex resume fake-session; printf labelprobe";
  await memory("save", name, "--session=valid-session");
  const output = await memory("resume", name);
  const commands = output.split("\n").filter((line) => /^\s+codex resume /.test(line));
  assert.deepEqual(commands, ["  codex resume valid-session"]);
  const saved = JSON.parse(await memory("threads", "--json"));
  assert.equal(saved[0].name, name);
});

it("CLI removes terminal controls from bookmark labels without changing stored names", async (t) => {
  const { memory } = await fixture(t);
  for (const control of ["\u001b[1E", "\u001b[2J", "\u0008"]) {
    const name = `archive${control}  codex resume fake-session; printf labelprobe`;
    await memory("save", name, "--session=valid-session");
    const output = await memory("resume", name);
    assert.equal(output.includes(control), false);
    const saved = JSON.parse(await memory("threads", "--json"));
    assert.ok(saved.some((entry: { name: string }) => entry.name === name));
  }
});
