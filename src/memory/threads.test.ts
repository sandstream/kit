import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb, upsertSession, insertMessage } from "./db.js";
import {
  saveThread,
  listThreads,
  getThread,
  removeThread,
  latestSessionId,
  resolveThread,
} from "./threads.js";

describe("memory threads (named copilots)", () => {
  const fresh = () => openMemoryDb(":memory:");

  it("save + list + get; name is the key (re-save updates)", () => {
    const db = fresh();
    saveThread(db, { name: "launch", sessionId: "s1", projectPath: "/repo/app-a" });
    saveThread(db, { name: "launch", sessionId: "s2", projectPath: "/repo/app-a" });
    assert.equal(listThreads(db).length, 1);
    assert.equal(getThread(db, "launch")?.session_id, "s2");
    db.close();
  });

  it("lists scoped by project", () => {
    const db = fresh();
    saveThread(db, { name: "a", sessionId: "s1", projectPath: "/repo/app-a" });
    saveThread(db, { name: "b", sessionId: "s2", projectPath: "/repo/app-b" });
    assert.equal(listThreads(db).length, 2);
    const scoped = listThreads(db, { projectPath: "/repo/app-a" });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.name, "a");
    db.close();
  });

  it("remove tosses a thread", () => {
    const db = fresh();
    saveThread(db, { name: "x", sessionId: "s1" });
    assert.equal(removeThread(db, "x"), true);
    assert.equal(listThreads(db).length, 0);
    assert.equal(removeThread(db, "x"), false);
    db.close();
  });

  it("latestSessionId picks the most recent session touching the project", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "old", harness: "claude-code" });
    upsertSession(db, { sessionId: "new", harness: "claude-code" });
    insertMessage(db, {
      uuid: "m1",
      sessionId: "old",
      type: "user",
      content: "a",
      cwd: "/repo/app-a",
      timestamp: "2026-06-01T00:00:00Z",
    });
    insertMessage(db, {
      uuid: "m2",
      sessionId: "new",
      type: "user",
      content: "b",
      cwd: "/repo/app-a",
      timestamp: "2026-06-02T00:00:00Z",
    });
    assert.equal(latestSessionId(db, { projectPath: "/repo/app-a" }), "new");
    db.close();
  });

  it("resolveThread accepts a name or a 1-based index", () => {
    const db = fresh();
    saveThread(db, { name: "first", sessionId: "s1", projectPath: "/repo/app-a" });
    saveThread(db, { name: "second", sessionId: "s2", projectPath: "/repo/app-a" });
    assert.equal(resolveThread(db, "first", { projectPath: "/repo/app-a" })?.session_id, "s1");
    const list = listThreads(db, { projectPath: "/repo/app-a" });
    assert.equal(resolveThread(db, "1", { projectPath: "/repo/app-a" })?.name, list[0]?.name);
    db.close();
  });
});
