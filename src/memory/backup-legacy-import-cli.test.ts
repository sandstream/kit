import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { saveMemoryKey } from "./backup.js";
import { keypair, modes, passphrase } from "./backup.test-support.js";
import { fixture } from "./pal-cli.test-support.js";
import type { PendingAction } from "./pal.js";
import {
  assertRecoveredActions,
  assertRecoveredHistory,
  assertScratchClean,
  isolate,
  legacySource,
} from "./backup-legacy-import.test-support.js";

for (const mode of modes) {
  it(`${mode.name} actual CLI sync recovers legacy history and keeps an approved local task executable`, async (t) => {
    const local = await fixture(t, "legacy-import-destination", {
      KIT_MEMORY_PASSPHRASE: passphrase,
    });
    const scratch = isolate(t, local.root);
    saveMemoryKey(keypair.privateJwk);
    const src = join(local.root, "legacy.db");
    const blob = join(local.root, "legacy.enc");
    legacySource(src);
    const sourceBytes = readFileSync(src);
    mode.backup(src, blob);
    const blobBytes = readFileSync(blob);
    await local.cli("add", "Local approved receipt", "--verify-file", src);
    assert.equal(JSON.parse(await local.cli("verify", "--json")).checked, 1);
    const [before] = JSON.parse(await local.cli("list", "--json")) as PendingAction[];
    assert.equal(before.verify_passes, 1);
    assert.ok(before.verify_grant);
    // The source CLI loader has already created its own cache in TMPDIR.
    const scratchBefore = readdirSync(scratch).sort();

    const output = await local.memory("sync", blob);
    assert.match(output, /synced .*1.* messages.*1.* sessions.*2.* pending.*1.* copilots/);
    const actions = JSON.parse(
      await local.cli("list", "--all", "--global", "--json"),
    ) as PendingAction[];
    assertRecoveredActions(actions);
    assert.deepEqual(
      actions.find((action) => action.id === before.id),
      before,
    );
    const history = JSON.parse(
      await local.memory("search", "Recoverycompanion", "--global", "--json"),
    );
    const [bookmark] = JSON.parse(await local.memory("threads", "--global", "--json"));
    assertRecoveredHistory(history.messages, bookmark);
    const verified = JSON.parse(await local.cli("verify", "--json"));
    assert.equal(verified.checked, 1);
    assert.deepEqual(verified.closed, [before.id]);
    assert.deepEqual(verified.unverified, []);
    assertRecoveredActions(JSON.parse(await local.cli("list", "--all", "--global", "--json")));
    assert.match(await local.memory("sync", blob), /already in sync/);
    assert.deepEqual(readFileSync(src), sourceBytes);
    assert.deepEqual(readFileSync(blob), blobBytes);
    assertScratchClean(scratch, scratchBefore);
  });
}
