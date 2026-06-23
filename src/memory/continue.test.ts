import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexContinueSessions } from "./continue.js";

describe("memory continue parser", () => {
  let tmp: string;
  const prev = process.env.KIT_CONTINUE_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-continue-"));
    const sessionsDir = join(tmp, ".continue", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    // A real session: string content + part-array content; system turn skipped.
    writeFileSync(
      join(sessionsDir, "sess-abc.json"),
      JSON.stringify({
        sessionId: "sess-abc",
        title: "demo",
        workspaceDirectory: "/Users/me/dev/widget",
        history: [
          { message: { role: "system", content: "you are helpful" } },
          { message: { role: "user", content: "december billing question" } },
          {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "the assistant reply" },
                { type: "imageUrl", imageUrl: { url: "data:..." } },
              ],
            },
          },
        ],
      }),
    );

    // The index file must be skipped (no history array).
    writeFileSync(
      join(sessionsDir, "sessions.json"),
      JSON.stringify([{ sessionId: "sess-abc", title: "demo" }]),
    );

    process.env.KIT_CONTINUE_DIR = join(tmp, ".continue");
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_CONTINUE_DIR;
    else process.env.KIT_CONTINUE_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes user + assistant turns, skips system + the index file, project-scopes via workspaceDirectory", () => {
    const db = openMemoryDb(":memory:");
    const res = indexContinueSessions(db);
    assert.equal(res.messages, 2); // user + assistant; system skipped, sessions.json skipped
    assert.equal(getStats(db).messages, 2);

    const session = db
      .prepare("SELECT harness, project FROM sessions WHERE session_id = 'continue:sess-abc'")
      .get() as { harness: string; project: string } | undefined;
    assert.equal(session?.harness, "continue");
    assert.equal(session?.project, "widget"); // basename of workspaceDirectory

    assert.equal(searchMessages(db, "december").length, 1);
    // project-scoped recall works because cwd was set from workspaceDirectory
    assert.equal(
      searchMessages(db, "assistant", { projectPath: "/Users/me/dev/widget" }).length,
      1,
    );
    db.close();
  });

  it("is incremental + idempotent — re-index skips the unchanged session", () => {
    const db = openMemoryDb(":memory:");
    indexContinueSessions(db);
    const second = indexContinueSessions(db);
    assert.equal(second.messages, 0);
    assert.equal(second.filesSkipped, 1);
    db.close();
  });
});
