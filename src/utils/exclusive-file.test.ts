import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileExclusive, writeFileExclusiveSync } from "./exclusive-file.js";

for (const [label, write] of [
  ["writeFileExclusiveSync", async (p: string, c: string) => writeFileExclusiveSync(p, c)],
  ["writeFileExclusive", (p: string, c: string) => writeFileExclusive(p, c)],
] as const) {
  describe(label, () => {
    it("publishes the complete content and leaves no staging directory behind", async () => {
      const dir = mkdtempSync(join(tmpdir(), "kit-exclusive-"));
      try {
        await write(join(dir, "out.txt"), "hello\n");
        assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "hello\n");
        assert.deepEqual(readdirSync(dir), ["out.txt"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("refuses an existing destination and leaves its bytes untouched", async () => {
      const dir = mkdtempSync(join(tmpdir(), "kit-exclusive-"));
      try {
        writeFileSync(join(dir, "out.txt"), "original");
        await assert.rejects(async () => write(join(dir, "out.txt"), "new"), /EEXIST/);
        assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "original");
        assert.deepEqual(readdirSync(dir), ["out.txt"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("refuses a dangling symlink destination without creating its target", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "kit-exclusive-"));
      try {
        const target = join(dir, "elsewhere.txt");
        try {
          symlinkSync(target, join(dir, "out.txt"));
        } catch {
          t.skip("cannot create symlinks here (Windows without the privilege)");
          return;
        }
        await assert.rejects(async () => write(join(dir, "out.txt"), "new"), /EEXIST/);
        assert.equal(existsSync(target), false, "the symlink target must not be created");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
