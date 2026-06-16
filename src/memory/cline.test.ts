import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexClineSessions } from "./cline.js";

describe("memory cline parser", () => {
  let tmp: string;
  const prev = process.env.KIT_CLINE_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-cline-"));
    const taskDir = join(tmp, "tasks", "1719000000000");
    mkdirSync(taskDir, { recursive: true });
    // api_conversation_history.json — Anthropic-format messages
    writeFileSync(
      join(taskDir, "api_conversation_history.json"),
      JSON.stringify([
        { role: "user", content: "march refactor question" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "the refactor plan" },
            { type: "tool_use", id: "t1", name: "write_file", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, // no text → skipped
      ]),
    );
    // a task dir with no conversation file → must be skipped, not crash
    mkdirSync(join(tmp, "tasks", "emptytask"), { recursive: true });
    process.env.KIT_CLINE_DIR = tmp;
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_CLINE_DIR;
    else process.env.KIT_CLINE_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes user+assistant text turns, skips tool-only turns + fileless tasks, tags harness=cline", () => {
    const db = openMemoryDb(":memory:");
    const res = indexClineSessions(db);
    assert.equal(res.messages, 2); // user(text) + assistant(text); tool_result-only user skipped
    assert.equal(getStats(db).messages, 2);

    const session = db
      .prepare("SELECT harness FROM sessions WHERE session_id = 'cline:1719000000000'")
      .get() as { harness: string } | undefined;
    assert.equal(session?.harness, "cline");

    assert.equal(searchMessages(db, "march").length, 1);
    assert.equal(searchMessages(db, "refactor plan").length, 1); // text block extracted from array content
    db.close();
  });

  it("is incremental + idempotent — re-index skips the unchanged task", () => {
    const db = openMemoryDb(":memory:");
    indexClineSessions(db);
    const second = indexClineSessions(db);
    assert.equal(second.messages, 0);
    assert.equal(second.filesSkipped, 1);
    db.close();
  });
});
