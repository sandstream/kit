import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexAntigravitySessions } from "./antigravity.js";

describe("memory antigravity parser", () => {
  let tmp: string;
  const prev = process.env.KIT_ANTIGRAVITY_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-antigravity-"));
    // ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl
    const logDir = join(tmp, "antigravity-cli", "brain", "conv-123", ".system_generated", "logs");
    mkdirSync(logDir, { recursive: true });
    const lines = [
      JSON.stringify({ source: "USER_INPUT", content: "december rollout question" }),
      JSON.stringify({ type: "MODEL", message: { text: "the rollout answer" } }),
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "planner step" }),
      JSON.stringify({ source: "TOOL_RESULT", content: "noise, no role → skipped" }),
    ].join("\n");
    writeFileSync(join(logDir, "transcript_full.jsonl"), lines);
    // A second conversation with only the truncated file → fallback path.
    const logDir2 = join(tmp, "antigravity-ide", "brain", "conv-456", ".system_generated", "logs");
    mkdirSync(logDir2, { recursive: true });
    writeFileSync(
      join(logDir2, "transcript.jsonl"),
      JSON.stringify({ source: "USER_INPUT", content: "fallback question" }),
    );
    process.env.KIT_ANTIGRAVITY_DIR = tmp;
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_ANTIGRAVITY_DIR;
    else process.env.KIT_ANTIGRAVITY_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("maps source/type enums to roles, skips non-turns, tags harness=antigravity", () => {
    const db = openMemoryDb(":memory:");
    const res = indexAntigravitySessions(db);
    // conv-123: user + MODEL + PLANNER (3), TOOL_RESULT skipped; conv-456: 1 = 4 total
    assert.equal(res.messages, 4);
    assert.equal(getStats(db).messages, 4);

    const session = db
      .prepare("SELECT harness FROM sessions WHERE session_id = 'antigravity:conv-123'")
      .get() as { harness: string } | undefined;
    assert.equal(session?.harness, "antigravity");

    assert.equal(searchMessages(db, "december").length, 1);
    // nested {message:{text}} extracted
    assert.equal(searchMessages(db, "rollout answer").length, 1);
    // truncated-file fallback conversation indexed too
    assert.equal(searchMessages(db, "fallback").length, 1);
    db.close();
  });

  it("is incremental + idempotent — re-index skips unchanged transcripts", () => {
    const db = openMemoryDb(":memory:");
    indexAntigravitySessions(db);
    const second = indexAntigravitySessions(db);
    assert.equal(second.messages, 0);
    assert.equal(second.filesSkipped, 2);
    db.close();
  });

  it("returns empty when no antigravity dirs exist (no false-green)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-antigravity-empty-"));
    process.env.KIT_ANTIGRAVITY_DIR = dir;
    const db = openMemoryDb(":memory:");
    assert.equal(indexAntigravitySessions(db).messages, 0);
    db.close();
    process.env.KIT_ANTIGRAVITY_DIR = tmp;
    rmSync(dir, { recursive: true, force: true });
  });
});
