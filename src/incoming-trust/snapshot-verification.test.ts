import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { captureIncomingSnapshot, verifyIncomingSnapshot } from "./snapshot.js";
import { snapshotFixture } from "./snapshot.test-support.js";

it(
  "verifies actual captured files and refuses modified, missing and added input",
  {
    skip:
      process.platform === "win32" &&
      "restoring a captured file with mode 0o600 does not reproduce its recorded identity on Windows; unverified on win32",
  },
  () => {
    const f = snapshotFixture();
    try {
      writeFileSync(join(f.source, "entry.js"), "reviewed bytes");
      const captured = captureIncomingSnapshot(f.source, f.destination);
      const check = () => verifyIncomingSnapshot(f.destination, captured.digest).ok;
      assert.equal(check(), true);
      assert.equal(verifyIncomingSnapshot(f.destination, "a".repeat(64)).ok, false);
      assert.equal(verifyIncomingSnapshot(f.destination, "invalid").ok, false);
      writeFileSync(join(f.source, "entry.js"), "later source edit");
      assert.equal(check(), true, "approval applies only to the captured tree");
      writeFileSync(join(captured.tree, "entry.js"), "different bytes");
      assert.equal(check(), false);
      rmSync(join(captured.tree, "entry.js"));
      assert.equal(check(), false);
      writeFileSync(join(captured.tree, "entry.js"), "reviewed bytes", { mode: 0o600 });
      assert.equal(check(), true);
      writeFileSync(join(captured.tree, ".hidden"), "additional input", { mode: 0o600 });
      assert.equal(check(), false);
      rmSync(join(captured.tree, ".hidden"));
      assert.equal(check(), true);
      writeFileSync(join(f.destination, "manifest.json"), "{}");
      assert.equal(check(), false);
    } finally {
      f.cleanup();
    }
  },
);
