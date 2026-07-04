import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexDroidSessions } from "./droid.js";

describe("memory droid parser", () => {
  let tmp: string;
  const prev = process.env.KIT_DROID_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-droid-"));
    // ~/.factory/projects/<projectHash>/<session-uuid>.jsonl — Claude-shaped lines.
    const dir = join(tmp, "projects", "a1b2c3");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "sess-droid",
        cwd: "/Users/me/dev/svc",
        timestamp: "2026-06-01T09:00:00Z",
        message: { role: "user", content: "november migration question" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        sessionId: "sess-droid",
        timestamp: "2026-06-01T09:00:05Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "the migration answer" },
            { type: "tool_use", name: "Execute", input: { command: "ls" } },
          ],
        },
      }),
      // A summary/system line with no user|assistant role → must be skipped.
      JSON.stringify({ type: "summary", summary: "irrelevant noise" }),
    ].join("\n");
    writeFileSync(join(dir, "sess-droid.jsonl"), lines);
    process.env.KIT_DROID_DIR = tmp;
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_DROID_DIR;
    else process.env.KIT_DROID_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes user + assistant turns (Claude-shaped blocks), skips non-turns, tags harness=droid", () => {
    const db = openMemoryDb(":memory:");
    const res = indexDroidSessions(db);
    assert.equal(res.messages, 2); // user + assistant; summary line skipped
    assert.equal(getStats(db).messages, 2);
    const session = db
      .prepare("SELECT harness FROM sessions WHERE session_id = 'sess-droid'")
      .get() as { harness: string } | undefined;
    assert.equal(session?.harness, "droid");
    assert.equal(searchMessages(db, "november").length, 1);
    // block-array text flattened ("answer" appears only in the assistant text block)
    assert.equal(searchMessages(db, "answer").length, 1);
    // project-scoped via the record cwd ("november" is only in the user turn)
    assert.equal(searchMessages(db, "november", { projectPath: "/Users/me/dev/svc" }).length, 1);
    db.close();
  });

  it("is incremental + idempotent — re-index skips the unchanged transcript", () => {
    const db = openMemoryDb(":memory:");
    indexDroidSessions(db);
    const second = indexDroidSessions(db);
    assert.equal(second.messages, 0);
    assert.equal(second.filesSkipped, 1);
    db.close();
  });

  it("fail-safe on a foreign line shape — indexes nothing rather than wrong text", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-droid-x-"));
    const pdir = join(dir, "projects", "zz");
    mkdirSync(pdir, { recursive: true });
    writeFileSync(
      join(pdir, "weird.jsonl"),
      [JSON.stringify({ kind: "telemetry", value: 42 }), "not json at all"].join("\n"),
    );
    process.env.KIT_DROID_DIR = dir;
    const db = openMemoryDb(":memory:");
    assert.equal(indexDroidSessions(db).messages, 0);
    db.close();
    process.env.KIT_DROID_DIR = tmp;
    rmSync(dir, { recursive: true, force: true });
  });
});
