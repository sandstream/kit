import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  openMemoryDb,
  upsertSession,
  insertMessage,
  searchMessages,
  getStats,
} from "./db.js";

describe("memory db", () => {
  const fresh = () => openMemoryDb(":memory:");

  it("creates schema and records the version", () => {
    const db = fresh();
    const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as {
      version: number;
    };
    assert.equal(row.version, SCHEMA_VERSION);
    db.close();
  });

  it("inserts a message and finds it via FTS5", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code", project: "/repo" });
    const added = insertMessage(db, {
      uuid: "u1",
      sessionId: "s1",
      type: "user",
      role: "user",
      content: "decision about October pricing",
    });
    assert.equal(added, true);
    const hits = searchMessages(db, "october");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.uuid, "u1");
    db.close();
  });

  it("is idempotent on message uuid (one row per message)", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    const first = insertMessage(db, {
      uuid: "dup",
      sessionId: "s1",
      type: "user",
      content: "hello",
    });
    const second = insertMessage(db, {
      uuid: "dup",
      sessionId: "s1",
      type: "user",
      content: "hello",
    });
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(getStats(db).messages, 1);
    db.close();
  });

  it("FTS5 does not match unrelated content", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, {
      uuid: "u1",
      sessionId: "s1",
      type: "user",
      content: "totally unrelated note",
    });
    assert.equal(searchMessages(db, "october").length, 0);
    db.close();
  });

  it("getStats counts sessions, messages and open pending actions", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: "a" });
    insertMessage(db, { uuid: "u2", sessionId: "s1", type: "assistant", content: "b" });
    db.prepare("INSERT INTO pending_actions(id, title) VALUES ('p1', 'do thing')").run();
    const stats = getStats(db);
    assert.equal(stats.sessions, 1);
    assert.equal(stats.messages, 2);
    assert.equal(stats.pendingOpen, 1);
    db.close();
  });
});
