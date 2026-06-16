import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import {
  extractText,
  extractToolUses,
  indexClaudeTranscripts,
} from "./parser.js";

describe("memory parser — content extraction", () => {
  it("returns strings unchanged", () => {
    assert.equal(extractText("hello world"), "hello world");
  });

  it("flattens text + tool_use blocks", () => {
    const content = [
      { type: "text", text: "Sure, here is the plan" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
      { type: "tool_result" },
    ];
    assert.equal(extractText(content), "Sure, here is the plan\n[Tool: Bash]\n[Tool Result]");
  });

  it("extracts tool_use blocks with serialized input", () => {
    const tools = extractToolUses([
      { type: "text", text: "x" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "Bash");
    assert.match(tools[0]?.input ?? "", /ls/);
  });
});

describe("memory parser — indexing", () => {
  let tmp: string;
  const prevClaudeDir = process.env.KIT_CLAUDE_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-mem-"));
    const projDir = join(tmp, "projects", "-repo-demo");
    mkdirSync(projDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u-1",
        sessionId: "sess-abc",
        parentUuid: null,
        timestamp: "2026-06-01T10:00:00Z",
        cwd: "/repo",
        gitBranch: "main",
        version: "1.0",
        message: { role: "user", content: "Let's discuss the October pricing decision" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "u-2",
        sessionId: "sess-abc",
        parentUuid: "u-1",
        timestamp: "2026-06-01T10:00:05Z",
        message: {
          role: "assistant",
          model: "claude-x",
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [
            { type: "text", text: "Sure, here is the plan" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      JSON.stringify({ type: "summary", summary: "pricing chat", leafUuid: "u-2" }),
      "   ", // blank/whitespace line — must be skipped
      "{not valid json", // malformed — must be skipped without aborting
    ].join("\n");
    writeFileSync(join(projDir, "sess-abc.jsonl"), lines);
    process.env.KIT_CLAUDE_DIR = tmp;
  });

  after(() => {
    if (prevClaudeDir === undefined) delete process.env.KIT_CLAUDE_DIR;
    else process.env.KIT_CLAUDE_DIR = prevClaudeDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes user + assistant messages, skips summary/blank/malformed", () => {
    const db = openMemoryDb(":memory:");
    const res = indexClaudeTranscripts(db);
    assert.equal(res.files, 1);
    assert.equal(res.messages, 2);
    assert.equal(res.toolUses, 1);
    const stats = getStats(db);
    assert.equal(stats.sessions, 1);
    assert.equal(stats.messages, 2);
    assert.equal(stats.toolUses, 1);
    db.close();
  });

  it("finds indexed content via FTS5", () => {
    const db = openMemoryDb(":memory:");
    indexClaudeTranscripts(db);
    const hits = searchMessages(db, "october");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.uuid, "u-1");
    db.close();
  });

  it("is idempotent + incremental — re-indexing skips the unchanged file", () => {
    const db = openMemoryDb(":memory:");
    const first = indexClaudeTranscripts(db);
    assert.equal(first.files, 1);
    assert.equal(first.filesSkipped, 0);
    const second = indexClaudeTranscripts(db);
    assert.equal(second.messages, 0); // nothing new on the second pass
    assert.equal(second.files, 0); // the file was not re-read
    assert.equal(second.filesSkipped, 1); // it was skipped (unchanged mtime + size)
    assert.equal(getStats(db).messages, 2);
    db.close();
  });
});
