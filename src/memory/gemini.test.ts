import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexGeminiSessions } from "./gemini.js";

describe("memory gemini parser", () => {
  let tmp: string;
  const prev = process.env.KIT_GEMINI_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-gemini-"));
    const projDir = join(tmp, "tmp", "abc123hash");
    const ckptDir = join(projDir, "checkpoints");
    mkdirSync(ckptDir, { recursive: true });

    // logs.json — user-query LogEntry array (+ one non-user entry)
    writeFileSync(
      join(projDir, "logs.json"),
      JSON.stringify([
        {
          sessionId: "sess-1",
          messageId: 0,
          timestamp: "2026-04-01T09:00:00Z",
          type: "user",
          message: "november roadmap question",
        },
        {
          sessionId: "sess-1",
          messageId: 1,
          timestamp: "2026-04-01T09:00:05Z",
          type: "gemini",
          message: "logged model reply",
        },
        {
          sessionId: "sess-1",
          messageId: 2,
          timestamp: "2026-04-01T09:00:10Z",
          type: "user",
          message: "",
        },
      ]),
    );

    // modern checkpoint — { history: Content[] }
    writeFileSync(
      join(ckptDir, "checkpoint-feature.json"),
      JSON.stringify({
        history: [
          { role: "user", parts: [{ text: "checkpoint user turn" }] },
          { role: "model", parts: [{ text: "checkpoint model turn" }] },
        ],
      }),
    );

    // a file-snapshot checkpoint that is NOT a conversation — must be skipped
    writeFileSync(
      join(ckptDir, "1700-file.txt-write_file.json"),
      JSON.stringify({ toolName: "write_file", filePath: "/x", content: "snapshot, not a turn" }),
    );

    // getGeminiTmpDir joins base + "tmp"; the fixture lives at <tmp>/tmp/<hash>
    process.env.KIT_GEMINI_DIR = tmp;
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_GEMINI_DIR;
    else process.env.KIT_GEMINI_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes logs.json + checkpoint turns, skips empty + non-conversation JSON, tags harness=gemini", () => {
    const db = openMemoryDb(":memory:");
    const res = indexGeminiSessions(db);
    // logs: 2 (user + gemini; empty skipped) + checkpoint: 2 = 4
    assert.equal(res.messages, 4);
    assert.equal(getStats(db).messages, 4);

    const harnesses = db.prepare("SELECT DISTINCT harness FROM sessions").all() as {
      harness: string;
    }[];
    assert.ok(harnesses.every((h) => h.harness === "gemini"));

    assert.equal(searchMessages(db, "november").length, 1);
    assert.equal(searchMessages(db, "checkpoint").length, 2);
    // the file-snapshot JSON must not have been indexed
    assert.equal(searchMessages(db, "snapshot").length, 0);
    db.close();
  });

  it("is incremental + idempotent — re-index skips unchanged files", () => {
    const db = openMemoryDb(":memory:");
    indexGeminiSessions(db);
    const second = indexGeminiSessions(db);
    assert.equal(second.messages, 0);
    assert.ok(second.filesSkipped >= 2); // logs.json + checkpoint(s)
    db.close();
  });
});
