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
});
