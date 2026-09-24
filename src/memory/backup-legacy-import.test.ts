import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { it } from "node:test";
import { saveMemoryKey } from "./backup.js";
import { fixture, keypair, modes, passphrase } from "./backup.test-support.js";
import { openMemoryDb, searchMessages } from "./db.js";
import { palAdd, palAutoVerify, palList } from "./pal.js";
import { syncFromExport } from "./sync.js";
import { getThread } from "./threads.js";
import {
  assertRecoveredActions,
  assertRecoveredHistory,
  assertScratchClean,
  isolate,
  legacySource,
} from "./backup-legacy-import.test-support.js";

for (const mode of modes) {
  it(`${mode.name} sync recovers schema-13 tasks, transcript and bookmark while retaining local approval`, async (t) => {
    const { dir, src, blob, dest, track } = fixture(t);
    const scratch = isolate(t, dir);
    saveMemoryKey(keypair.privateJwk);
    legacySource(src);
    const sourceBytes = readFileSync(src);
    mode.backup(src, blob);
    const blobBytes = readFileSync(blob);
    assert.throws(() => mode.restore(blob, dest), /legacy verification.*memory sync/i);
    assert.equal(existsSync(dest), false);
    const target = track(openMemoryDb(dest));
    const localId = palAdd(target, {
      title: "Locally approved receipt",
      check: { type: "file-exists", path: src },
    });
    assert.equal((await palAutoVerify(target)).checked, 1);
    const [localBefore] = palList(target, { readOnly: true });
    assert.equal(localBefore.verify_passes, 1);
    assert.ok(localBefore.verify_grant);

    const result = syncFromExport(target, blob, { passphrase });
    assert.deepEqual(
      [result.sessions, result.messages, result.pending, result.threads],
      [1, 1, 2, 1],
    );
    const actions = palList(target, { allDevices: true, readOnly: true });
    assertRecoveredActions(actions);
    assert.deepEqual(
      actions.find((action) => action.id === localId),
      localBefore,
    );
    assertRecoveredHistory(
      searchMessages(target, "Recoverycompanion"),
      getThread(target, "legacy-bookmark"),
    );
    const verified = await palAutoVerify(target);
    assert.equal(verified.checked, 1);
    assert.deepEqual(verified.closed, [localId]);
    assert.deepEqual(verified.unverified, []);
    assertRecoveredActions(palList(target, { allDevices: true, readOnly: true }));
    assert.deepEqual(readFileSync(src), sourceBytes);
    assert.deepEqual(readFileSync(blob), blobBytes);
    assertScratchClean(scratch);
  });

  for (const poisoned of ["transcript", "check"] as const) {
    it(`${mode.name} legacy sync rejects ${poisoned} injection before target mutation and removes decrypted temporary files`, async (t) => {
      const { dir, src, blob, dest, track } = fixture(t);
      const scratch = isolate(t, dir);
      saveMemoryKey(keypair.privateJwk);
      legacySource(src, poisoned);
      const sourceBytes = readFileSync(src);
      mode.backup(src, blob);
      const blobBytes = readFileSync(blob);
      const target = track(openMemoryDb(dest));
      const id = palAdd(target, {
        title: "Local receipt",
        check: { type: "file-exists", path: src },
      });
      assert.equal((await palAutoVerify(target)).checked, 1);
      const actions = palList(target, { allDevices: true, readOnly: true });
      target.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const beforeBytes = readFileSync(dest);
      const beforeChanges = target.prepare("SELECT total_changes() AS n").get();

      assert.throws(
        () => syncFromExport(target, blob, { passphrase }),
        /refusing to merge: incoming memory has .*high-confidence injection/,
      );
      assert.deepEqual(target.prepare("SELECT total_changes() AS n").get(), beforeChanges);
      assert.deepEqual(readFileSync(dest), beforeBytes);
      assert.deepEqual(palList(target, { allDevices: true, readOnly: true }), actions);
      assert.deepEqual(searchMessages(target, "Recoverycompanion"), []);
      assert.equal(getThread(target, "legacy-bookmark"), undefined);
      assert.deepEqual((await palAutoVerify(target)).closed, [id]);
      assert.deepEqual(readFileSync(src), sourceBytes);
      assert.deepEqual(readFileSync(blob), blobBytes);
      assertScratchClean(scratch);
    });
  }
}
