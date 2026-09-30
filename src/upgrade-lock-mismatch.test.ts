/**
 * `kit upgrade` locks what is installed. When the installed version does not satisfy the
 * declared pin (node 25 on PATH, `node = "22"` in .kit.toml), writing it would produce a lock
 * that contradicts the project's own declaration and reads as in sync. It must refuse instead.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
const env = {
  ...process.env,
  KIT_NO_UPDATE_CHECK: "1",
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
};

async function upgrade(toml: string): Promise<{ code: number; stderr: string; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "kit-upgrade-lock-"));
  writeFileSync(join(cwd, ".kit.toml"), toml);
  try {
    await exec(process.execPath, [CLI, "upgrade"], { cwd, env, timeout: 60_000 });
    return { code: 0, stderr: "", cwd };
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stderr: e.stderr ?? "", cwd };
  }
}

describe("kit upgrade: the lock never contradicts the declaration (compiled CLI)", () => {
  it("refuses, and writes no cli-lock, when the installed version misses the pin", async () => {
    const r = await upgrade('[tools]\nnode = "1"\n');
    try {
      assert.equal(r.code, 1);
      assert.match(r.stderr, /node.*does not satisfy.*1/);
      // "Lock files not written" must be true of every lock file, not only the cli lock.
      assert.equal(existsSync(join(r.cwd, ".kit")), false, "a refused upgrade writes nothing");
    } finally {
      rmSync(r.cwd, { recursive: true, force: true });
    }
  });

  it("locks the exact installed version when it satisfies the pin", async () => {
    const major = process.versions.node.split(".")[0];
    const r = await upgrade(`[tools]\nnode = "${major}"\n`);
    try {
      assert.equal(r.code, 0, r.stderr);
      const lock = JSON.parse(readFileSync(join(r.cwd, ".kit", "cli-lock.json"), "utf8"));
      assert.match(lock.tools.node.version, new RegExp(`^${major}\\.\\d+\\.\\d+$`));
    } finally {
      rmSync(r.cwd, { recursive: true, force: true });
    }
  });
});
