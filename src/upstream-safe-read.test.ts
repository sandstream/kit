import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { entryExists, readRegularFileIfPresent } from "./upstream-safe-read.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function inDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "kit-safe-read-"));
  try {
    body(dir);
  } finally {
    rmTemp(dir);
  }
}

describe("readRegularFileIfPresent", () => {
  it("reads a regular file", () =>
    inDir((dir) => {
      writeFileSync(join(dir, "a.txt"), "hello");
      assert.equal(readRegularFileIfPresent(join(dir, "a.txt")), "hello");
    }));

  it("returns null for a file that does not exist", () =>
    inDir((dir) => assert.equal(readRegularFileIfPresent(join(dir, "missing")), null)));

  it("refuses a symlink with a fixed message and never reads its target", () =>
    inDir((dir) => {
      writeFileSync(join(dir, "secret.txt"), "TOP-SECRET-VALUE");
      symlinkSync(join(dir, "secret.txt"), join(dir, "link"));
      assert.throws(
        () => readRegularFileIfPresent(join(dir, "link")),
        (err: Error) => /is a symlink/.test(err.message) && !err.message.includes("TOP-SECRET"),
      );
    }));

  it("refuses a dangling symlink the same way", () =>
    inDir((dir) => {
      symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
      // Windows opens the link's target, finds nothing there and reports the file as absent.
      if (process.platform === "win32")
        assert.equal(readRegularFileIfPresent(join(dir, "dangling")), null);
      else assert.throws(() => readRegularFileIfPresent(join(dir, "dangling")), /is a symlink/);
    }));

  it("refuses a folder", () =>
    inDir((dir) => {
      mkdirSync(join(dir, "sub"));
      assert.throws(() => readRegularFileIfPresent(join(dir, "sub")), /not a regular file/);
    }));

  it(
    "refuses a named pipe at once instead of waiting for a writer",
    { skip: process.platform === "win32", timeout: 5_000 },
    () =>
      inDir((dir) => {
        execFileSync("mkfifo", [join(dir, "pipe")]);
        assert.throws(() => readRegularFileIfPresent(join(dir, "pipe")), /not a regular file/);
      }),
  );

  it("refuses a file above the size cap", () =>
    inDir((dir) => {
      writeFileSync(join(dir, "big"), Buffer.alloc(8 * 1024 * 1024 + 1));
      assert.throws(() => readRegularFileIfPresent(join(dir, "big")), /too large/);
    }));
});

it("stops at the observed file size when a repository file grows", (t) =>
  inDir((dir) => {
    const file = join(dir, "changed");
    writeFileSync(file, "a");
    const read = fs.readSync;
    const spy = t.mock.method(
      fs,
      "readSync",
      (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        appendFileSync(file, "extra bytes");
        return read(fd, buffer, offset, length, position);
      },
    );
    syncBuiltinESMExports();
    try {
      assert.throws(() => readRegularFileIfPresent(file), /size changed/);
      assert.equal(spy.mock.callCount(), 1);
      assert.equal(spy.mock.calls[0].arguments[3], 2);
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  }));

describe("entryExists", () => {
  it("is true for a file, a symlink and a folder, and false for nothing", () =>
    inDir((dir) => {
      writeFileSync(join(dir, "f"), "x");
      symlinkSync(join(dir, "f"), join(dir, "l"));
      mkdirSync(join(dir, "d"));
      assert.deepEqual(
        ["f", "l", "d", "none"].map((n) => entryExists(join(dir, n))),
        [true, true, true, false],
      );
    }));
});
