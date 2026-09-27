/**
 * `--version` is a global flag, so the unknown-flag floor lets it through on every command, but
 * only `kit --version` (first position) honoured it. `kit upgrade --version` therefore ran the
 * upgrade and rewrote the lock files while the operator asked for a version string. Like
 * `--help`, it must be answered before any command is dispatched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "cli.js");
const VERSION = JSON.parse(readFileSync(resolve(HERE, "..", "package.json"), "utf8")).version;

describe("--version after a command (compiled CLI)", () => {
  for (const command of ["upgrade", "install", "check"]) {
    it(`kit ${command} --version prints the version and runs nothing`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "kit-version-anywhere-"));
      try {
        writeFileSync(join(cwd, ".kit.toml"), '[tools]\nnode = "22"\n');
        const { stdout } = await exec(process.execPath, [CLI, command, "--version"], {
          cwd,
          env: { ...process.env, KIT_NO_UPDATE_CHECK: "1" },
          timeout: 30_000,
        });
        assert.ok(stdout.includes(VERSION), `expected ${VERSION} in: ${stdout}`);
        assert.equal(existsSync(join(cwd, ".kit")), false, "no lock or state file may be written");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
