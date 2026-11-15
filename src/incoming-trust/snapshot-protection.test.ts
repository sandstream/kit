import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { it } from "node:test";
import { captureIncomingSnapshot, verifyIncomingSnapshot } from "./snapshot.js";
import { snapshotFixture } from "./snapshot.test-support.js";

const posix = {
  skip:
    process.platform === "win32"
      ? "These controls use POSIX modes and links; Windows ACL and reparse-point evidence is separate."
      : false,
};

it("refuses a linked destination parent without writing through the link", posix, () => {
  const f = snapshotFixture();
  try {
    const target = join(f.root, "private");
    const alias = join(f.root, "alias");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync("private", alias);
    assert.throws(
      () => captureIncomingSnapshot(f.source, join(alias, "captured")),
      /uncontrolled-destination/,
    );
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    f.cleanup();
  }
});

it("verification refuses public copied permissions and external hard links", posix, () => {
  const f = snapshotFixture();
  try {
    fs.writeFileSync(join(f.source, "input"), "private bytes");
    const captured = captureIncomingSnapshot(f.source, f.destination);
    const path = join(captured.tree, "input");
    fs.chmodSync(path, 0o644);
    assert.equal(verifyIncomingSnapshot(f.destination, captured.digest).ok, false);
    fs.chmodSync(path, 0o600);
    assert.equal(verifyIncomingSnapshot(f.destination, captured.digest).ok, true);
    fs.linkSync(path, join(f.root, "outside-copy"));
    assert.equal(verifyIncomingSnapshot(f.destination, captured.digest).ok, false);
  } finally {
    f.cleanup();
  }
});

it(
  "failed capture preserves a replacement destination it does not own",
  {
    skip:
      process.platform === "win32" &&
      "the test renames a directory that the capture still holds open, which Windows refuses (EPERM); unverified on win32",
  },
  (t) => {
    const f = snapshotFixture();
    try {
      fs.writeFileSync(join(f.source, "input"), "source bytes");
      t.mock.method(fs, "readSync", () => {
        fs.renameSync(f.destination, join(f.root, "moved-capture"));
        fs.mkdirSync(f.destination, { mode: 0o700 });
        fs.writeFileSync(join(f.destination, "keep"), "replacement bytes");
        throw new Error("expected read interruption");
      });
      syncBuiltinESMExports();
      assert.throws(
        () => captureIncomingSnapshot(f.source, f.destination),
        /expected read interruption/,
      );
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal(fs.readFileSync(join(f.destination, "keep"), "utf8"), "replacement bytes");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      f.cleanup();
    }
  },
);
