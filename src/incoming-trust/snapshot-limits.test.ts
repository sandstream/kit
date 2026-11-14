import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { captureIncomingSnapshot } from "./snapshot.js";
import { snapshotFixture } from "./snapshot.test-support.js";
import type { IncomingSnapshotLimits } from "./snapshot.js";

it("refuses a byte budget overrun and removes its partial destination", () => {
  const f = snapshotFixture();
  try {
    writeFileSync(join(f.source, "a"), "abc");
    writeFileSync(join(f.source, "b"), "def");
    assert.throws(
      () => captureIncomingSnapshot(f.source, f.destination, { maxBytes: 5 }),
      /input-limit/,
    );
    assert.equal(existsSync(f.destination), false);
  } finally {
    f.cleanup();
  }
});

for (const limits of [
  { maxEntries: 1 },
  { maxFileBytes: 2 },
  { maxDepth: 0 },
  { maxPathBytes: 2 },
  { maxManifestBytes: 64 },
] satisfies Partial<IncomingSnapshotLimits>[]) {
  it(`enforces the ${Object.keys(limits)[0]} budget without a partial result`, () => {
    const f = snapshotFixture();
    try {
      writeFileSync(join(f.source, "file"), "abc");
      assert.throws(
        () => captureIncomingSnapshot(f.source, f.destination, limits),
        /input-limit|manifest-limit/,
      );
      assert.equal(existsSync(f.destination), false);
    } finally {
      f.cleanup();
    }
  });
}

it("refuses invalid budgets before creating storage", () => {
  const f = snapshotFixture();
  try {
    for (const maxBytes of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => captureIncomingSnapshot(f.source, f.destination, { maxBytes }),
        /invalid-limits/,
      );
      assert.equal(existsSync(f.destination), false);
    }
  } finally {
    f.cleanup();
  }
});
