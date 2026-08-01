import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

// `kit hooks uninstall` — the wire for `uninstallHooks`, which was exported and called by
// nothing (self-audit rule 15) since hooks shipped: kit could install git hooks and had no
// way to remove them. Driven end-to-end through a real temp git repo, because the defect
// that matters here is not in the function — it is in WHICH hook names the command passes
// it, and only the filesystem can settle that.

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function kit(args: string[], cwd: string): Promise<Run> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1" },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Hook files git itself would run — `.sample` files are inert templates. */
async function liveHooks(repo: string): Promise<string[]> {
  const dir = join(repo, ".git", "hooks");
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => !f.endsWith(".sample")).sort();
}

describe("kit hooks uninstall", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "kit-hooks-uninstall-"));
    await exec("git", ["init", "-q", "."], { cwd: repo });
    await writeFile(join(repo, ".kit.toml"), '[hooks]\npre-commit = ["echo hi"]\n', "utf-8");
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("install writes the configured hook AND the bypass-detector pair", async () => {
    // Establishes the precondition the uninstall has to undo. `post-commit` is not in
    // `.kit.toml` — it comes from the sentinel pair — which is exactly why uninstalling
    // only the configured names is wrong.
    const r = await kit(["hooks", "install"], repo);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(await liveHooks(repo), ["post-commit", "pre-commit"]);
  });

  it("removes every hook it installed, including the post-commit detector", async () => {
    // The bug this pins: leaving `post-commit` behind with the pre-commit sentinel
    // writer gone makes it report EVERY later commit as "bypassed pre-commit
    // (sentinel-missing)" — a permanent false alarm from a hook the operator asked to
    // have removed.
    const r = await kit(["hooks", "uninstall"], repo);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(await liveHooks(repo), [], "no live hook may survive an uninstall");
  });

  it("reports what it removed, not the internal 'installed' action name", async () => {
    // `uninstallHooks` reuses action:"installed" to mean "removed". The operator must
    // never see that quirk.
    await kit(["hooks", "install"], repo);
    const r = await kit(["hooks", "uninstall"], repo);
    assert.match(r.stdout, /pre-commit/);
    assert.match(r.stdout, /removed/);
    assert.equal(/\binstalled\b/.test(r.stdout), false, "must not say 'installed' on removal");
  });

  it("says enforcement is now off, so the state change is not silent", async () => {
    await kit(["hooks", "install"], repo);
    const r = await kit(["hooks", "uninstall"], repo);
    assert.match(r.stdout, /Enforcement is now off/i);
  });

  it("is idempotent — a second uninstall skips and still succeeds", async () => {
    const r = await kit(["hooks", "uninstall"], repo);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /skipped/);
  });

  it("install after uninstall restores both hooks — the cycle is reversible", async () => {
    const r = await kit(["hooks", "install"], repo);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(await liveHooks(repo), ["post-commit", "pre-commit"]);
  });

  it("lists uninstall in the usage line for an unknown subcommand", async () => {
    // A capability nobody can discover is barely wired at all.
    const r = await kit(["hooks", "totally-not-a-subcommand"], repo);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /uninstall/);
  });

  it("reports no hooks configured rather than failing when .kit.toml has none", async () => {
    const bare = await mkdtemp(join(tmpdir(), "kit-hooks-bare-"));
    try {
      await exec("git", ["init", "-q", "."], { cwd: bare });
      await writeFile(join(bare, ".kit.toml"), '[tools]\nnode = "22"\n', "utf-8");
      const r = await kit(["hooks", "uninstall"], bare);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /No hooks configured/i);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
