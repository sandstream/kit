import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { it } from "node:test";
import { captureIncomingSnapshot } from "./snapshot.js";
import { snapshotFixture } from "./snapshot.test-support.js";

for (const changedPath of ["a", "z"]) {
  it(`refuses a real edit of ${changedPath} during a later descriptor read`, (t) => {
    const f = snapshotFixture();
    const original = fs.readSync;
    let injected = false;
    try {
      fs.writeFileSync(join(f.source, "a"), "earlier bytes");
      fs.writeFileSync(join(f.source, "z"), "trigger edit");
      // Inject a real filesystem edit at the external read boundary, without timing races.
      t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
        const count = Reflect.apply(original, fs, args);
        const buffer = args[1];
        if (
          !injected &&
          Buffer.isBuffer(buffer) &&
          buffer.subarray(0, count).toString() === "trigger edit"
        ) {
          injected = true;
          fs.writeFileSync(join(f.source, changedPath), "changed source bytes");
        }
        return count;
      });
      syncBuiltinESMExports();
      assert.throws(() => captureIncomingSnapshot(f.source, f.destination), /source-changed/);
      assert.equal(injected, true);
      assert.equal(fs.existsSync(f.destination), false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      f.cleanup();
    }
  });
}

it(
  "refuses a FIFO without opening it as file data or leaving a partial capture",
  {
    skip:
      process.platform === "win32"
        ? "This fixture uses POSIX mkfifo; Windows named pipes require native verification."
        : false,
    timeout: 10_000,
  },
  () => {
    const f = snapshotFixture();
    try {
      execFileSync("mkfifo", [join(f.source, "pipe")]);
      assert.throws(() => captureIncomingSnapshot(f.source, f.destination), /unsupported-file/);
      assert.equal(fs.existsSync(f.destination), false);
    } finally {
      f.cleanup();
    }
  },
);
