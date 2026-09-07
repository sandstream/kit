/**
 * End-to-end: `kit sentinel run` writes `.kit/sentinel.json` (a SessionStart-surface
 * cache, see #53) unconditionally today. Read-only mode's banner promises "all writes
 * will be refused"; this cache is a write like any other, so it must not persist
 * behind that banner's back (RO-5). Asserts on the real compiled CLI against a real
 * (empty) git tree, not a mock, since the defect is specifically about what lands on
 * disk.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

describe("kit sentinel run (compiled CLI): read-only mode (RO-5)", () => {
  it("never writes .kit/sentinel.json under KIT_READ_ONLY=1", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-sentinel-ro-"));
    try {
      await exec(process.execPath, [CLI_PATH, "sentinel", "run", "--json"], {
        cwd,
        env: { ...process.env, KIT_READ_ONLY: "1" },
        timeout: 30_000,
      });
      assert.equal(
        existsSync(join(cwd, ".kit", "sentinel.json")),
        false,
        "read-only mode must not leave an untracked .kit/sentinel.json behind",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("writes .kit/sentinel.json when NOT in read-only mode (contrast case)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-sentinel-rw-"));
    try {
      const env = { ...process.env };
      delete env.KIT_READ_ONLY;
      await exec(process.execPath, [CLI_PATH, "sentinel", "run", "--json"], {
        cwd,
        env,
        timeout: 30_000,
      });
      assert.equal(existsSync(join(cwd, ".kit", "sentinel.json")), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
