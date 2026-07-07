import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, upsertSession, insertMessage, getStats } from "./db.js";
import { palAdd } from "./pal.js";
import { mergeDb } from "./merge.js";

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
