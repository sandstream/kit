import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { backupEncrypted } from "./backup.js";
import { passphrase } from "./backup.test-support.js";
import { fixture } from "./pal-cli.test-support.js";
import {
  assertRecoveredActions,
  assertScratchClean,
  isolate,
  legacySource,
} from "./backup-legacy-import.test-support.js";

export interface LegacyRestoreFixture {
  name: string;
  column: "verify_check" | "verify_cmd";
  value: string;
}

export function checkLegacyRestore(legacy: LegacyRestoreFixture): void {
  void it(`actual CLI restore --force refuses a nonnull legacy ${legacy.name} with sync guidance before overwriting`, async (t) => {
    const local = await fixture(t, "legacy-import-destination", {
      KIT_MEMORY_PASSPHRASE: passphrase,
    });
    const scratch = isolate(t, local.root);
    const src = join(local.root, "legacy.db");
    const blob = join(local.root, "legacy.enc");
    legacySource(src);
    const source = new DatabaseSync(src);
    try {
      source.exec("UPDATE pending_actions SET verify_check=NULL, verify_cmd=NULL, kind='manual'");
      source
        .prepare(`UPDATE pending_actions SET ${legacy.column}=? WHERE id='legacy-file'`)
        .run(legacy.value);
    } finally {
      source.close();
    }
    const sourceBytes = readFileSync(src);
    backupEncrypted(passphrase, src, blob);
    const blobBytes = readFileSync(blob);
    await local.cli("add", "Keep local task", "--verify-file", src);
    const before = await local.cli("list", "--json");
    const destinationBytes = readFileSync(local.dbPath);
    const entries = readdirSync(dirname(local.dbPath)).sort();
    const scratchBefore = readdirSync(scratch).sort();

    await assert.rejects(local.memory("restore", blob, "--force"), (error: unknown) => {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? "", /legacy verification.*memory sync/i);
      assert.doesNotMatch(failure.stdout ?? "", /restored/);
      t.diagnostic(failure.stderr ?? "");
      return true;
    });
    assert.deepEqual(readFileSync(local.dbPath), destinationBytes);
    assert.deepEqual(readdirSync(dirname(local.dbPath)).sort(), entries);
    assert.equal(await local.cli("list", "--json"), before);
    assert.equal(JSON.parse(await local.cli("verify", "--json")).checked, 1);
    assert.match(await local.memory("sync", blob), /synced/);
    assertRecoveredActions(JSON.parse(await local.cli("list", "--all", "--global", "--json")));
    assert.deepEqual(readFileSync(src), sourceBytes);
    assert.deepEqual(readFileSync(blob), blobBytes);
    assertScratchClean(scratch, scratchBefore);
  });
}
