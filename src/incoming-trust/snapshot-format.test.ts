import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { captureIncomingSnapshot } from "./snapshot.js";
import { snapshotFixture } from "./snapshot.test-support.js";

it("uses the version-one manifest digest for an empty captured tree", () => {
  const f = snapshotFixture();
  try {
    const captured = captureIncomingSnapshot(f.source, f.destination);
    const manifest =
      '{"schema":"kit.incoming-snapshot","version":1,"entries":[{"path":"","kind":"directory"}]}';
    assert.equal(readFileSync(join(f.destination, "manifest.json"), "utf8"), manifest);
    // Independent Python hashlib vector for the literal version-one manifest above.
    assert.equal(
      captured.digest,
      "10a1d48d50078a8638954739991cb65bd47cf2042f9fb028ed90e98c1161249b",
    );
  } finally {
    f.cleanup();
  }
});

it("ignores host paths and creation order while binding names, bytes and empty directories", () => {
  const f = snapshotFixture();
  try {
    const other = join(f.root, "other-source");
    mkdirSync(other);
    for (const name of ["b", "a"]) writeFileSync(join(f.source, name), name);
    for (const name of ["a", "b"]) writeFileSync(join(other, name), name);
    const first = captureIncomingSnapshot(f.source, f.destination);
    assert.equal(captureIncomingSnapshot(other, join(f.root, "same")).digest, first.digest);
    writeFileSync(join(other, "a"), "changed");
    assert.notEqual(captureIncomingSnapshot(other, join(f.root, "changed")).digest, first.digest);
    writeFileSync(join(other, "a"), "a");
    mkdirSync(join(other, "empty"));
    assert.notEqual(captureIncomingSnapshot(other, join(f.root, "directory")).digest, first.digest);
  } finally {
    f.cleanup();
  }
});

it(
  "binds executable intent without running the captured file",
  {
    skip:
      process.platform === "win32"
        ? "POSIX execute bits do not establish Windows execution semantics."
        : false,
  },
  () => {
    const f = snapshotFixture();
    try {
      const file = join(f.source, "run.sh");
      writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      const first = captureIncomingSnapshot(f.source, f.destination);
      chmodSync(file, 0o700);
      const executable = captureIncomingSnapshot(f.source, join(f.root, "executable"));
      assert.notEqual(executable.digest, first.digest);
    } finally {
      f.cleanup();
    }
  },
);
