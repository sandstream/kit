import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, upsertSession, insertMessage, getStats } from "./db.js";
import { backupEncrypted, restoreEncrypted } from "./backup.js";

describe("memory encrypted backup / restore", () => {
  it("roundtrips data; a wrong passphrase fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-bak-"));
    const src = join(tmp, "memory.db");
    const enc = join(tmp, "backup.kitmem");
    const dest = join(tmp, "restored.db");

    let db = openMemoryDb(src);
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: "october plans" });
    db.close();

    backupEncrypted("Galaxy-Vortex-Quartz-2026-x9", src, enc);
    assert.ok(existsSync(enc));

    assert.throws(() => restoreEncrypted("wrong passphrase", enc, dest), /./);
    assert.ok(!existsSync(dest), "no plaintext db is written on a failed restore");

    restoreEncrypted("Galaxy-Vortex-Quartz-2026-x9", enc, dest);
    db = openMemoryDb(dest);
    assert.equal(getStats(db).messages, 1);
    db.close();

    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "writes the backup and the restored db with 0600 perms (V2 magic)",
    { skip: process.platform === "win32" },
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "kit-bak4-"));
      const src = join(tmp, "memory.db");
      const enc = join(tmp, "backup.kitmem");
      const dest = join(tmp, "restored.db");
      openMemoryDb(src).close();

      backupEncrypted("Galaxy-Vortex-Quartz-2026-x9", src, enc);
      assert.equal(statSync(enc).mode & 0o777, 0o600, "encrypted blob must be 0600");
      assert.equal(
        readFileSync(enc).subarray(0, 8).toString(),
        "KITMEM02",
        "new backups use the hardened-KDF v2 magic",
      );

      restoreEncrypted("Galaxy-Vortex-Quartz-2026-x9", enc, dest);
      assert.equal(statSync(dest).mode & 0o777, 0o600, "restored plaintext db must be 0600");
      rmSync(tmp, { recursive: true, force: true });
    },
  );

  it("refuses a too-short or obviously-weak passphrase (fail before encrypting)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-bak3-"));
    const src = join(tmp, "memory.db");
    const enc = join(tmp, "backup.kitmem");
    openMemoryDb(src).close();
    assert.throws(() => backupEncrypted("short", src, enc), /weak/);
    assert.throws(() => backupEncrypted("valfri-stark-passphrase", src, enc), /weak/); // long but placeholder
    assert.ok(!existsSync(enc), "no backup is written when the passphrase is rejected");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects a non-backup file (bad magic)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kit-bak2-"));
    const bogus = join(tmp, "not-a-backup.bin");
    const db = openMemoryDb(join(tmp, "x.db")); // create a plain sqlite file
    db.close();
    assert.throws(() => restoreEncrypted("p", join(tmp, "x.db"), bogus), /magic/);
    rmSync(tmp, { recursive: true, force: true });
  });
});
