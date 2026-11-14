import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { captureIncomingSnapshot, verifyIncomingSnapshot } from "./snapshot.js";
import { snapshotFixture } from "./snapshot.test-support.js";

it("preserves UTF-8 names, binary data, empty directories and leading filename BOMs", () => {
  const f = snapshotFixture();
  try {
    mkdirSync(join(f.source, "k\u00e4lla"));
    mkdirSync(join(f.source, "empty"));
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    writeFileSync(join(f.source, "k\u00e4lla", "\u00e5-😀"), bytes);
    writeFileSync(join(f.source, "\ufeffname"), "BOM name");
    writeFileSync(join(f.source, "name"), "plain name");
    const captured = captureIncomingSnapshot(f.source, f.destination);
    assert.equal(captured.files, 3);
    assert.deepEqual(readFileSync(join(captured.tree, "k\u00e4lla", "\u00e5-😀")), bytes);
    assert.equal(readFileSync(join(captured.tree, "\ufeffname"), "utf8"), "BOM name");
    assert.equal(readFileSync(join(captured.tree, "name"), "utf8"), "plain name");
    assert.equal(verifyIncomingSnapshot(f.destination, captured.digest).ok, true);
  } finally {
    f.cleanup();
  }
});
