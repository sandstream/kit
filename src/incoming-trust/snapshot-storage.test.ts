import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { it } from "node:test";
import { secureDirStrict } from "../utils/secure-perms.js";
import { captureIncomingSnapshot, verifyIncomingSnapshot } from "./snapshot.js";
import { snapshotFixture } from "./snapshot.test-support.js";

it(
  "cleans the newly owned destination if its permission setup fails",
  {
    skip:
      process.platform === "win32"
        ? "This injects a POSIX chmod failure; native Windows ACL failures need separate verification."
        : false,
  },
  (t) => {
    const f = snapshotFixture();
    const target = join(fs.realpathSync(dirname(f.destination)), basename(f.destination));
    const original = fs.chmodSync;
    try {
      t.mock.method(fs, "chmodSync", (path: fs.PathLike, mode: fs.Mode) => {
        if (path === target) throw new Error("expected permission failure");
        return original(path, mode);
      });
      syncBuiltinESMExports();
      assert.throws(
        () => captureIncomingSnapshot(f.source, f.destination),
        /expected permission failure/,
      );
      assert.equal(fs.existsSync(f.destination), false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      f.cleanup();
    }
  },
);

it("refuses existing destinations and overlap without removing their contents", () => {
  const f = snapshotFixture();
  try {
    fs.mkdirSync(f.destination);
    fs.writeFileSync(join(f.destination, "keep"), "existing content");
    assert.throws(() => captureIncomingSnapshot(f.source, f.destination), /destination-exists/);
    assert.equal(fs.readFileSync(join(f.destination, "keep"), "utf8"), "existing content");
    // The destination's parent must be controlled before overlap is judged; on Windows a plain
    // temp folder inherits an ACL that is not.
    secureDirStrict(f.source);
    assert.throws(
      () => captureIncomingSnapshot(f.source, join(f.source, "captured")),
      /overlapping-paths/,
    );
    assert.equal(fs.existsSync(join(f.source, "captured")), false);
  } finally {
    f.cleanup();
  }
});

it("verification refuses additional files beside the captured tree", () => {
  const f = snapshotFixture();
  try {
    const captured = captureIncomingSnapshot(f.source, f.destination);
    fs.writeFileSync(join(f.destination, "unexpected"), "unrecorded input", { mode: 0o600 });
    assert.equal(verifyIncomingSnapshot(f.destination, captured.digest).ok, false);
    assert.equal(fs.readFileSync(join(f.destination, "unexpected"), "utf8"), "unrecorded input");
  } finally {
    f.cleanup();
  }
});

it("read-only mode refuses capture and permits file-preserving verification", () => {
  const f = snapshotFixture();
  const before = process.env.KIT_READ_ONLY;
  try {
    const captured = captureIncomingSnapshot(f.source, f.destination);
    const names = fs.readdirSync(f.destination);
    process.env.KIT_READ_ONLY = "1";
    const next = join(f.root, "another-capture");
    assert.throws(() => captureIncomingSnapshot(f.source, next), /read-only/);
    assert.equal(fs.existsSync(next), false);
    assert.equal(verifyIncomingSnapshot(f.destination, captured.digest).ok, true);
    assert.deepEqual(fs.readdirSync(f.destination), names);
  } finally {
    if (before === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = before;
    f.cleanup();
  }
});
