import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fingerprintKitBuild } from "./launch-build-identity.js";
import { snapshotFixture } from "./snapshot.test-support.js";

it("binds built code outside the old hand-picked recipe list and detects newly added modules", () => {
  const f = snapshotFixture();
  try {
    const subtree = join(f.source, "incoming-trust");
    mkdirSync(subtree);
    writeFileSync(join(f.source, "cli.js"), "export {}");
    const integrity = join(subtree, "npm-artifact-integrity.js");
    writeFileSync(integrity, "export const revision = 1");
    const original = fingerprintKitBuild(f.source);
    writeFileSync(join(subtree, "example.test.js"), "test-only code");
    assert.equal(fingerprintKitBuild(f.source).digest, original.digest);
    writeFileSync(integrity, "export const revision = 2");
    assert.equal(original.check(), false);
    const updated = fingerprintKitBuild(f.source);
    assert.notEqual(updated.digest, original.digest);
    writeFileSync(join(subtree, "new-module.js"), "export {}");
    assert.equal(updated.check(), false);
  } finally {
    f.cleanup();
  }
});
