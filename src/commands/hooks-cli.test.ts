/**
 * `kit hooks install` and `kit hooks check`, driven through the real CLI in a temp git repo. They
 * pin the words an operator reads for each hook state and the exit value, so the command can be
 * split without changing either.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adjacentCli = resolve(moduleRoot, "cli.js");
const CLI_PATH = existsSync(adjacentCli) ? adjacentCli : resolve(moduleRoot, "../dist/cli.js");

// Colour codes are not the contract; the words and their order are.
const plain = (text: string | undefined): string => (text ?? "").replace(/\x1b\[[0-9;]*m/g, "");

async function kit(args: string[], cwd: string) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1" },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout: plain(stdout), stderr: plain(stderr) };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: e.code ?? 1, stdout: plain(e.stdout), stderr: plain(e.stderr) };
  }
}

describe("kit hooks install and check", () => {
  let repo: string;
  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "kit-hooks-cli-"));
    await exec("git", ["init", "-q", "."], { cwd: repo });
    await writeFile(join(repo, ".kit.toml"), '[hooks]\npre-commit = ["echo hi"]\n', "utf-8");
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("check reports a hook that is not installed, fails, and names the fix", async () => {
    const r = await kit(["hooks", "check"], repo);
    assert.equal(r.exitCode, 1, r.stderr);
    assert.match(r.stdout, /Git Hooks/);
    assert.match(r.stdout, /✗ pre-commit\s+not installed/);
    assert.match(r.stdout, /Run kit hooks install to install\/update hooks/);
  });

  it("install writes the hook and says installed; a second install does not claim it installed again", async () => {
    const first = await kit(["hooks", "install"], repo);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stdout, /Installing git hooks/);
    assert.match(first.stdout, /✓ pre-commit\s+installed/);
    const second = await kit(["hooks", "install"], repo);
    assert.equal(second.exitCode, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /pre-commit\s+installed/);
    assert.match(second.stdout, /pre-commit\s+(skipped|updated)/);
  });

  it("check reports an installed hook as up-to-date and succeeds", async () => {
    const r = await kit(["hooks", "check"], repo);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /✓ pre-commit\s+up-to-date/);
    assert.doesNotMatch(r.stdout, /kit hooks install to install/);
  });

  it("check reports a changed hook as outdated and fails", async () => {
    const path = join(repo, ".git", "hooks", "pre-commit");
    const original = await readFile(path, "utf-8");
    await writeFile(path, original.replaceAll("echo hi", "echo changed"), { mode: 0o755 });
    const r = await kit(["hooks", "check"], repo);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /✗ pre-commit\s+outdated/);
    await kit(["hooks", "install"], repo);
  });

  it(
    "check reports a hook git will not run as not executable",
    { skip: process.platform === "win32" },
    async () => {
      const path = join(repo, ".git", "hooks", "pre-commit");
      await chmod(path, 0o644);
      const r = await kit(["hooks", "check"], repo);
      assert.equal(r.exitCode, 1);
      assert.match(r.stdout, /✗ pre-commit\s+not executable/);
      await kit(["hooks", "install"], repo);
    },
  );

  it("fails with a plain line outside a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "kit-hooks-nogit-"));
    try {
      await writeFile(join(plain, ".kit.toml"), '[hooks]\npre-commit = ["echo hi"]\n', "utf-8");
      for (const sub of ["install", "check", "uninstall"]) {
        const r = await kit(["hooks", sub], plain);
        assert.equal(r.exitCode, 1, `${sub}: ${r.stderr}`);
        assert.match(r.stdout, /Not a git repository/);
      }
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
