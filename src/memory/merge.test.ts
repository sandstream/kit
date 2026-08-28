import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openMemoryDb,
  upsertSession,
  insertMessage,
  getStats,
  forgetMemory,
  countTombstones,
} from "./db.js";
import { palAdd } from "./pal.js";
import { mergeDb } from "./merge.js";

function messageCount(db: ReturnType<typeof openMemoryDb>, uuid: string): number {
  return (db.prepare("SELECT COUNT(*) c FROM messages WHERE uuid = ?").get(uuid) as { c: number })
    .c;
}

describe("memory merge", () => {
  it("merges another store deduped by uuid; re-merge is a no-op", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-merge-"));
    const srcPath = join(tmp, "source.db");

    // A source brain (e.g. an old laptop)
    const src = openMemoryDb(srcPath);
    upsertSession(src, { sessionId: "s1", harness: "codex" });
    insertMessage(src, {
      uuid: "a",
      sessionId: "s1",
      type: "user",
      content: "from the old laptop",
    });
    insertMessage(src, { uuid: "b", sessionId: "s1", type: "assistant", content: "reply" });
    palAdd(src, { title: "old todo", scope: "proj" });
    src.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // flush WAL so readOnly open sees it all
    src.close();

    const target = openMemoryDb(":memory:");
    upsertSession(target, { sessionId: "s0", harness: "claude-code" });
    insertMessage(target, { uuid: "z", sessionId: "s0", type: "user", content: "already here" });

    const r1 = mergeDb(target, srcPath);
    assert.equal(r1.messages, 2);
    assert.equal(r1.pending, 1);
    assert.equal(getStats(target).messages, 3); // z + a + b

    const r2 = mergeDb(target, srcPath); // idempotent re-merge
    assert.equal(r2.messages, 0);
    assert.equal(r2.pending, 0);
    assert.equal(getStats(target).messages, 3);

    target.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws on a missing source", () => {
    const target = openMemoryDb(":memory:");
    assert.throws(() => mergeDb(target, "/nope/missing.db"), /not found/);
    target.close();
  });

  it("does not resurrect incoming messages that the target has tombstoned (#549)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-merge-"));
    const srcPath = join(tmp, "source.db");

    const src = openMemoryDb(srcPath);
    upsertSession(src, { sessionId: "s1", harness: "codex" });
    insertMessage(src, { uuid: "gone", sessionId: "s1", type: "user", content: "forgotten" });
    insertMessage(src, { uuid: "keep", sessionId: "s1", type: "user", content: "keep me" });
    src.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    src.close();

    const target = openMemoryDb(":memory:");
    upsertSession(target, { sessionId: "s1", harness: "codex" });
    insertMessage(target, { uuid: "gone", sessionId: "s1", type: "user", content: "forgotten" });
    assert.equal(forgetMemory(target, "gone", "test").ok, true);

    const r = mergeDb(target, srcPath);
    assert.equal(r.messages, 1);
    assert.equal(r.tombstoneBlockedMessages, 1);
    assert.equal(messageCount(target, "gone"), 0);
    assert.equal(messageCount(target, "keep"), 1);
    assert.equal(countTombstones(target), 1);

    target.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("propagates source tombstones and deletes stale target messages (#549)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-merge-"));
    const forgottenPath = join(tmp, "forgotten.db");
    const stalePath = join(tmp, "stale.db");

    const forgotten = openMemoryDb(forgottenPath);
    upsertSession(forgotten, { sessionId: "s1", harness: "codex" });
    insertMessage(forgotten, { uuid: "gone", sessionId: "s1", type: "user", content: "erase" });
    assert.equal(forgetMemory(forgotten, "gone", "sync delete").ok, true);
    forgotten.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    forgotten.close();

    const stale = openMemoryDb(stalePath);
    upsertSession(stale, { sessionId: "s1", harness: "codex" });
    insertMessage(stale, { uuid: "gone", sessionId: "s1", type: "user", content: "erase" });
    stale.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    stale.close();

    const target = openMemoryDb(":memory:");
    upsertSession(target, { sessionId: "s1", harness: "codex" });
    insertMessage(target, { uuid: "gone", sessionId: "s1", type: "user", content: "erase" });

    const r1 = mergeDb(target, forgottenPath);
    assert.equal(r1.tombstones, 1);
    assert.equal(r1.tombstoneDeletedMessages, 1);
    assert.equal(messageCount(target, "gone"), 0);
    assert.equal(countTombstones(target), 1);

    const r2 = mergeDb(target, stalePath);
    assert.equal(r2.messages, 0);
    assert.equal(r2.tombstoneBlockedMessages, 1);
    assert.equal(messageCount(target, "gone"), 0);

    target.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports imported project keys so a foreign scope is loud (#247)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-merge-"));
    const srcPath = join(tmp, "container.db");
    const src = openMemoryDb(srcPath);
    upsertSession(src, { sessionId: "c1", harness: "claude-code", project: "-home-user" });
    insertMessage(src, { uuid: "m1", sessionId: "c1", type: "user", content: "in a container" });
    src.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    src.close();

    const target = openMemoryDb(":memory:");
    const r = mergeDb(target, srcPath);
    assert.deepEqual(r.projects, { "-home-user": 1 });
    target.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("--remap-project rehomes imported sessions into the given project (#247)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-merge-"));
    const srcPath = join(tmp, "container.db");
    const src = openMemoryDb(srcPath);
    upsertSession(src, { sessionId: "c1", harness: "claude-code", project: "-home-user" });
    insertMessage(src, { uuid: "m1", sessionId: "c1", type: "user", content: "in a container" });
    src.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    src.close();

    const target = openMemoryDb(":memory:");
    const r = mergeDb(target, srcPath, { remapProject: "/Users/x/dev/kit" });
    assert.deepEqual(r.projects, { "-Users-x-dev-kit": 1 });
    const row = target.prepare("SELECT project FROM sessions WHERE session_id = 'c1'").get() as {
      project: string;
    };
    assert.equal(row.project, "-Users-x-dev-kit");

    // Re-merge with remap also rehomes an ALREADY-imported foreign session
    // (upsert: a non-null incoming project wins) — the recovery path when the
    // first merge forgot the flag.
    const target2 = openMemoryDb(":memory:");
    mergeDb(target2, srcPath); // first: lands foreign
    mergeDb(target2, srcPath, { remapProject: "/Users/x/dev/kit" }); // rehome
    const row2 = target2.prepare("SELECT project FROM sessions WHERE session_id = 'c1'").get() as {
      project: string;
    };
    assert.equal(row2.project, "-Users-x-dev-kit");
    target.close();
    target2.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
