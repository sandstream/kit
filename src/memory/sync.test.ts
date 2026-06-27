import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, upsertSession, insertMessage, getStats, markFileIndexed } from "./db.js";
import { backupEncrypted } from "./backup.js";
import { syncFromExport } from "./sync.js";

const PASSPHRASE = "round-trip-secret-phrase-9182";

function countFileIndex(db: ReturnType<typeof openMemoryDb>): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM file_index").get() as { n: number }).n);
}

describe("memory sync", () => {
  it("round-trips a raw .db export: B's rows appear in A, file_index excluded", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-sync-"));
    try {
      // Machine B's export
      const srcPath = join(tmp, "machineB.db");
      const src = openMemoryDb(srcPath);
      upsertSession(src, { sessionId: "sB", harness: "codex" });
      insertMessage(src, { uuid: "b1", sessionId: "sB", type: "user", content: "from machine B" });
      // file_index is machine-local — record one so we can prove it does NOT cross.
      markFileIndexed(src, "/home/B/.claude/projects/x/session.jsonl", 123, 456);
      assert.equal(countFileIndex(src), 1);
      src.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      src.close();

      // Machine A (local)
      const target = openMemoryDb(":memory:");
      upsertSession(target, { sessionId: "sA", harness: "claude-code" });
      insertMessage(target, { uuid: "a1", sessionId: "sA", type: "user", content: "local" });

      const r = syncFromExport(target, srcPath);
      assert.equal(r.messages, 1);
      assert.equal(getStats(target).messages, 2); // a1 + b1
      assert.equal(countFileIndex(target), 0, "machine-local file_index is NOT synced");

      target.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("last-write-wins on a session conflict (harness/last_message_at updated)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-sync-"));
    try {
      const srcPath = join(tmp, "src.db");
      const src = openMemoryDb(srcPath);
      upsertSession(src, {
        sessionId: "shared",
        harness: "codex",
        lastMessageAt: "2026-06-27T10:00:00Z",
      });
      src.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      src.close();

      const target = openMemoryDb(":memory:");
      upsertSession(target, {
        sessionId: "shared",
        harness: "claude-code",
        lastMessageAt: "2026-01-01T00:00:00Z",
      });

      syncFromExport(target, srcPath);
      const row = target
        .prepare("SELECT harness, last_message_at FROM sessions WHERE session_id = 'shared'")
        .get() as { harness: string; last_message_at: string };
      assert.equal(row.harness, "codex", "merged source wins");
      assert.equal(row.last_message_at, "2026-06-27T10:00:00Z");
      target.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("decrypts and syncs an encrypted backup blob", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-sync-"));
    try {
      const srcDb = join(tmp, "src.db");
      const src = openMemoryDb(srcDb);
      upsertSession(src, { sessionId: "sE", harness: "gemini" });
      insertMessage(src, { uuid: "e1", sessionId: "sE", type: "user", content: "encrypted" });
      src.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      src.close();

      const blob = join(tmp, "backup.kitmem");
      backupEncrypted(PASSPHRASE, srcDb, blob);

      const target = openMemoryDb(":memory:");
      const r = syncFromExport(target, blob, { passphrase: PASSPHRASE });
      assert.equal(r.messages, 1);
      assert.equal(getStats(target).messages, 1);
      target.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("errors clearly on an encrypted backup with no passphrase", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-sync-"));
    try {
      const srcDb = join(tmp, "src.db");
      const src = openMemoryDb(srcDb);
      upsertSession(src, { sessionId: "sX", harness: "codex" });
      src.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      src.close();
      const blob = join(tmp, "b.kitmem");
      backupEncrypted(PASSPHRASE, srcDb, blob);

      const target = openMemoryDb(":memory:");
      assert.throws(() => syncFromExport(target, blob), /encrypted backup/);
      target.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("errors clearly on a missing export", () => {
    const target = openMemoryDb(":memory:");
    assert.throws(() => syncFromExport(target, "/nope/missing.db"), /export not found/);
    target.close();
  });
});
