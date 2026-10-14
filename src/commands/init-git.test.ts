import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ensureGitRepo } from "./init-git.js";

const never = async (): Promise<boolean> => {
  throw new Error("must not prompt");
};

async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kit-init-git-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("runs git init in a directory with no repo when nobody can be asked", () =>
  inTempDir(async (dir) => {
    const result = await ensureGitRepo({ cwd: dir, nonInteractive: true, confirm: never });
    assert.equal(result, "initialized");
    assert.equal(existsSync(join(dir, ".git")), true);
  }));

it("asks first when a person is present, and does nothing on a no", () =>
  inTempDir(async (dir) => {
    const confirm = async () => false;
    const result = await ensureGitRepo({ cwd: dir, nonInteractive: false, confirm });
    assert.equal(result, "declined");
    assert.equal(existsSync(join(dir, ".git")), false);
  }));

it("initializes after a yes", () =>
  inTempDir(async (dir) => {
    const confirm = async () => true;
    const result = await ensureGitRepo({ cwd: dir, nonInteractive: false, confirm });
    assert.equal(result, "initialized");
    assert.equal(existsSync(join(dir, ".git")), true);
  }));

it("leaves an existing repo alone and never prompts", () =>
  inTempDir(async (dir) => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const result = await ensureGitRepo({ cwd: dir, nonInteractive: false, confirm: never });
    assert.equal(result, "present");
  }));

it("does not create a nested repo inside a subdirectory of an existing repo", () =>
  inTempDir(async (dir) => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const sub = join(dir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    const result = await ensureGitRepo({ cwd: sub, nonInteractive: true, confirm: never });
    assert.equal(result, "present");
    assert.equal(existsSync(join(sub, ".git")), false);
  }));
