import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexCursorSessions } from "./cursor.js";

describe("memory cursor parser", () => {
  let tmp: string;
  let fixture: string;
  const prev = process.env.KIT_CURSOR_DB;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-cursor-"));
    fixture = join(tmp, "state.vscdb");
    const src = new DatabaseSync(fixture);
    src.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const ins = src.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run("bubbleId:comp1:b1", JSON.stringify({ type: 1, text: "september latency question" }));
    ins.run("bubbleId:comp1:b2", JSON.stringify({ type: 2, text: "the assistant explanation" }));
    ins.run("bubbleId:comp1:b3", JSON.stringify({ type: 2, text: "" })); // empty → skipped
    ins.run("bubbleId:comp1:b4", JSON.stringify({ type: 0, text: "system noise" })); // not 1/2 → skipped
    ins.run("composerData:comp1", JSON.stringify({ name: "session meta, not a bubble" }));
    ins.run("someOtherKey", JSON.stringify({ irrelevant: true }));
    src.close();
    process.env.KIT_CURSOR_DB = fixture;
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_CURSOR_DB;
    else process.env.KIT_CURSOR_DB = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes user(type1)+assistant(type2) bubbles, skips empty/non-turn/metadata, tags harness=cursor", () => {
    const db = openMemoryDb(":memory:");
    const res = indexCursorSessions(db);
    assert.equal(res.messages, 2); // b1 + b2; empty/type0/composerData/other skipped
    assert.equal(getStats(db).messages, 2);

    const session = db
      .prepare("SELECT harness FROM sessions WHERE session_id = 'cursor:comp1'")
      .get() as { harness: string } | undefined;
    assert.equal(session?.harness, "cursor");

    assert.equal(searchMessages(db, "september").length, 1);
    assert.equal(searchMessages(db, "explanation").length, 1);
    // metadata/other rows must not have been indexed
    assert.equal(searchMessages(db, "noise").length, 0);
    db.close();
  });

  it("is incremental + idempotent — re-index of the unchanged db skips it", () => {
    const db = openMemoryDb(":memory:");
    indexCursorSessions(db);
    const second = indexCursorSessions(db);
    assert.equal(second.messages, 0);
    assert.equal(second.filesSkipped, 1);
    db.close();
  });

  it("is fail-safe when the cursorDiskKV table is absent (foreign DB shape)", () => {
    const otherDir = mkdtempSync(join(tmpdir(), "kit-cursor-empty-"));
    const otherDb = join(otherDir, "state.vscdb");
    const src = new DatabaseSync(otherDb);
    src.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)"); // not cursorDiskKV
    src.close();
    process.env.KIT_CURSOR_DB = otherDb;

    const db = openMemoryDb(":memory:");
    const res = indexCursorSessions(db);
    assert.equal(res.messages, 0); // no crash, nothing indexed
    db.close();

    process.env.KIT_CURSOR_DB = fixture;
    rmSync(otherDir, { recursive: true, force: true });
  });
});
