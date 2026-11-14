import assert from "node:assert/strict";
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { captureIncomingSnapshot, verifyIncomingSnapshot } from "./snapshot.js";
import { snapshotFixture } from "./snapshot.test-support.js";

const needsSymlink = {
  skip:
    process.platform === "win32"
      ? "Native Windows file symlinks require separate privilege and platform verification."
      : false,
};

it("retains internal relative link objects and binds their targets", needsSymlink, () => {
  const f = snapshotFixture();
  try {
    mkdirSync(join(f.source, "packages"));
    writeFileSync(join(f.source, "packages", "file"), "package bytes");
    symlinkSync("packages/file", join(f.source, "alias"));
    symlinkSync("missing", join(f.source, "dangling"));
    const captured = captureIncomingSnapshot(f.source, f.destination);
    assert.equal(readlinkSync(join(captured.tree, "alias")), "packages/file");
    assert.equal(readlinkSync(join(captured.tree, "dangling")), "missing");
    assert.equal(verifyIncomingSnapshot(f.destination, captured.digest).ok, true);
    rmSync(join(captured.tree, "alias"));
    symlinkSync("packages/other", join(captured.tree, "alias"));
    assert.equal(verifyIncomingSnapshot(f.destination, captured.digest).ok, false);
  } finally {
    f.cleanup();
  }
});

for (const target of [
  "../outside",
  "/absolute/outside",
  "C:/outside",
  "C:outside",
  "..\\outside",
]) {
  it(`refuses an escaping or nonportable link target ${target}`, needsSymlink, () => {
    const f = snapshotFixture();
    try {
      writeFileSync(join(f.source, "first"), "copied before refusal");
      symlinkSync(target, join(f.source, "last"));
      assert.throws(() => captureIncomingSnapshot(f.source, f.destination), /unsupported-link/);
      assert.equal(existsSync(f.destination), false);
    } finally {
      f.cleanup();
    }
  });
}

it("captures relative internal link targets containing a colon", needsSymlink, () => {
  const f = snapshotFixture();
  try {
    writeFileSync(join(f.source, "report:2026"), "ordinary file bytes");
    const plain = captureIncomingSnapshot(f.source, f.destination);
    assert.equal(verifyIncomingSnapshot(f.destination, plain.digest).ok, true);
    symlinkSync("./report:2026", join(f.source, "alias"));
    const destination = join(f.root, "with-link");
    const linked = captureIncomingSnapshot(f.source, destination);
    assert.equal(readlinkSync(join(linked.tree, "alias")), "./report:2026");
    assert.equal(verifyIncomingSnapshot(destination, linked.digest).ok, true);
    assert.notEqual(linked.digest, plain.digest);
  } finally {
    f.cleanup();
  }
});

it("refuses parent traversal through an otherwise internal directory link", needsSymlink, () => {
  const f = snapshotFixture();
  try {
    symlinkSync(".", join(f.source, "alias"));
    symlinkSync("alias/../outside", join(f.source, "escape"));
    writeFileSync(join(f.root, "outside"), "must remain outside");
    assert.throws(() => captureIncomingSnapshot(f.source, f.destination), /unsupported-link/);
    assert.equal(existsSync(f.destination), false);
  } finally {
    f.cleanup();
  }
});
