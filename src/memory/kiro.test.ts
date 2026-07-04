import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexKiroSessions } from "./kiro.js";

describe("memory kiro parser", () => {
  let tmp: string;
  let fixture: string;
  const prev = process.env.KIT_KIRO_DB;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-kiro-"));
    fixture = join(tmp, "data.sqlite3");
    const src = new DatabaseSync(fixture);
    // Newer Kiro builds use `conversations_v2`; keep a legacy `conversations`
    // table around too to prove the v2 table is PREFERRED, not merged.
    src.exec("CREATE TABLE conversations (key TEXT PRIMARY KEY, value TEXT)");
    src.exec("CREATE TABLE conversations_v2 (key TEXT PRIMARY KEY, value TEXT)");
    src
      .prepare("INSERT INTO conversations (key, value) VALUES (?, ?)")
      .run("/legacy/ignored", JSON.stringify({ history: [{ user: { content: "legacy turn" } }] }));
    const ins = src.prepare("INSERT INTO conversations_v2 (key, value) VALUES (?, ?)");
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
    process.env.KIT_KIRO_DB = fixture;
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_KIRO_DB;
    else process.env.KIT_KIRO_DB = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prefers conversations_v2, indexes history turns (defensive extraction), tags harness=kiro", () => {
    const db = openMemoryDb(":memory:");
    const res = indexKiroSessions(db);
    // From conversations_v2 only: turn 1 user+assistant (2) + turn 2 assistant (1) = 3.
    // The legacy `conversations` "legacy turn" must NOT be indexed.
    assert.equal(res.messages, 3);
    assert.equal(getStats(db).messages, 3);
    assert.equal(searchMessages(db, "legacy").length, 0);

    const session = db
      .prepare("SELECT harness FROM sessions WHERE session_id = 'kiro:/Users/me/dev/api'")
      .get() as { harness: string } | undefined;
    assert.equal(session?.harness, "kiro");

    assert.equal(searchMessages(db, "february").length, 1);
    // nested {content:{text}} was extracted
    assert.equal(searchMessages(db, "deploy answer").length, 1);
    // project-scoped via the conversation key path
    assert.equal(searchMessages(db, "assistant", { projectPath: "/Users/me/dev/api" }).length, 1);
    db.close();
  });

  it("falls back to legacy `conversations` when v2 is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-kiro-legacy-"));
    const legacyDb = join(dir, "data.sqlite3");
    const s = new DatabaseSync(legacyDb);
    s.exec("CREATE TABLE conversations (key TEXT PRIMARY KEY, value TEXT)");
    s.prepare("INSERT INTO conversations (key, value) VALUES (?, ?)").run(
      "/Users/me/dev/old",
      JSON.stringify({ history: [{ user: { content: "old cli turn" } }] }),
    );
    s.close();
    process.env.KIT_KIRO_DB = legacyDb;
    const db = openMemoryDb(":memory:");
    assert.equal(indexKiroSessions(db).messages, 1);
    assert.equal(searchMessages(db, "old cli").length, 1);
    db.close();
    process.env.KIT_KIRO_DB = fixture;
    rmSync(dir, { recursive: true, force: true });
  });

  it("is incremental + idempotent, and fail-safe on a foreign DB shape", () => {
    const db = openMemoryDb(":memory:");
    indexKiroSessions(db);
    const second = indexKiroSessions(db);
    assert.equal(second.messages, 0);
    assert.equal(second.filesSkipped, 1);
    db.close();

    // foreign schema → no crash, nothing indexed
    const otherDir = mkdtempSync(join(tmpdir(), "kit-kiro-x-"));
    const otherDb = join(otherDir, "data.sqlite3");
    const s = new DatabaseSync(otherDb);
    s.exec("CREATE TABLE other (a TEXT)");
    s.close();
    process.env.KIT_KIRO_DB = otherDb;
    const db2 = openMemoryDb(":memory:");
    assert.equal(indexKiroSessions(db2).messages, 0);
    db2.close();
    process.env.KIT_KIRO_DB = fixture;
    rmSync(otherDir, { recursive: true, force: true });
  });
});
