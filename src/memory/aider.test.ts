import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexAiderSessions } from "./aider.js";

describe("memory aider parser", () => {
  let tmp: string;
  let historyFile: string;
  const prev = process.env.KIT_AIDER_HISTORY;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-aider-"));
    historyFile = join(tmp, ".aider.chat.history.md");
    const md = [
      "# aider chat started at 2026-05-01 10:00:00",
      "",
      "> Added src/app.py to the chat.", // aider output — skipped
      "",
      "#### how do I add september retries?", // user turn (one line)
      "",
      "Here is the retry approach.", // assistant prose
      "You wrap the call in a loop.",
      "",
      "> Applied edit to src/app.py", // aider output boundary
      "> Commit abc123", // more aider output
      "",
      "#### and a second question", // second user turn
      "#### spanning two lines", // continuation of same user turn
      "",
      "The combined answer.", // assistant
    ].join("\n");
    writeFileSync(historyFile, md);
    process.env.KIT_AIDER_HISTORY = historyFile;
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_AIDER_HISTORY;
    else process.env.KIT_AIDER_HISTORY = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses #### user turns + plain assistant prose, skips > output, tags harness=aider", () => {
    const db = openMemoryDb(":memory:");
    const res = indexAiderSessions(db);
    // 2 user turns + 2 assistant turns = 4; the "> " lines are not indexed.
    assert.equal(res.messages, 4);
    assert.equal(getStats(db).messages, 4);

    const session = db
      .prepare("SELECT harness FROM sessions WHERE session_id = ?")
      .get(`aider:${historyFile}:0`) as { harness: string } | undefined;
    assert.equal(session?.harness, "aider");

    assert.equal(searchMessages(db, "september").length, 1);
    assert.equal(searchMessages(db, "retry approach").length, 1);
    // aider's own git/shell output must NOT be indexed
    assert.equal(searchMessages(db, "Commit").length, 0);
    // two-line user turn merged into one message
    assert.equal(searchMessages(db, "spanning").length, 1);
    db.close();
  });

  it("is incremental + idempotent — re-index skips the unchanged log", () => {
    const db = openMemoryDb(":memory:");
    indexAiderSessions(db);
    const second = indexAiderSessions(db);
    assert.equal(second.messages, 0);
    assert.equal(second.filesSkipped, 1);
    db.close();
  });

  it("returns empty when no aider log is present (no false-green)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-aider-empty-"));
    process.env.KIT_AIDER_HISTORY = join(dir, ".aider.chat.history.md");
    const db = openMemoryDb(":memory:");
    assert.equal(indexAiderSessions(db).messages, 0);
    db.close();
    process.env.KIT_AIDER_HISTORY = historyFile;
    rmSync(dir, { recursive: true, force: true });
  });
});
