import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexAmazonQSessions } from "./amazonq.js";

describe("memory amazon-q parser", () => {
  let tmp: string;
  let fixture: string;
  const prev = process.env.KIT_AMAZONQ_DB;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-amazonq-"));
    fixture = join(tmp, "data.sqlite3");
    const src = new DatabaseSync(fixture);
    src.exec("CREATE TABLE conversations (key TEXT PRIMARY KEY, value TEXT)");
    const ins = src.prepare("INSERT INTO conversations (key, value) VALUES (?, ?)");
    // value = JSON ConversationState. user.content as a string; assistant.content
    // wrapped in an object to exercise the defensive extractor.
    ins.run(
      "/Users/me/dev/api",
      JSON.stringify({
        history: [
          {
            user: { content: "february deploy question" },
            assistant: { content: { text: "the deploy answer" } },
          },
          {
            user: { content: "" }, // empty user → skipped, assistant still indexed
            assistant: { content: "second assistant turn" },
          },
        ],
        transcript: ["> february deploy question", "the deploy answer"],
      }),
    );
    src.close();
    process.env.KIT_AMAZONQ_DB = fixture;
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_AMAZONQ_DB;
    else process.env.KIT_AMAZONQ_DB = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes history turns (defensive content extraction), project-scopes via key, tags harness=amazon-q", () => {
    const db = openMemoryDb(":memory:");
    const res = indexAmazonQSessions(db);
    // turn 1: user + assistant (2); turn 2: empty user skipped + assistant (1) = 3
    assert.equal(res.messages, 3);
    assert.equal(getStats(db).messages, 3);

    const session = db
      .prepare("SELECT harness FROM sessions WHERE session_id = 'amazon-q:/Users/me/dev/api'")
      .get() as { harness: string } | undefined;
    assert.equal(session?.harness, "amazon-q");

    assert.equal(searchMessages(db, "february").length, 1);
    // nested {content:{text}} was extracted
    assert.equal(searchMessages(db, "deploy answer").length, 1);
    // project-scoped via the conversation key path
    assert.equal(searchMessages(db, "assistant", { projectPath: "/Users/me/dev/api" }).length, 1);
    db.close();
  });

  it("is incremental + idempotent, and fail-safe on a foreign DB shape", () => {
    const db = openMemoryDb(":memory:");
    indexAmazonQSessions(db);
    const second = indexAmazonQSessions(db);
    assert.equal(second.messages, 0);
    assert.equal(second.filesSkipped, 1);
    db.close();

    // foreign schema → no crash, nothing indexed
    const otherDir = mkdtempSync(join(tmpdir(), "kit-amazonq-x-"));
    const otherDb = join(otherDir, "data.sqlite3");
    const s = new DatabaseSync(otherDb);
    s.exec("CREATE TABLE other (a TEXT)");
    s.close();
    process.env.KIT_AMAZONQ_DB = otherDb;
    const db2 = openMemoryDb(":memory:");
    assert.equal(indexAmazonQSessions(db2).messages, 0);
    db2.close();
    process.env.KIT_AMAZONQ_DB = fixture;
    rmSync(otherDir, { recursive: true, force: true });
  });
});
