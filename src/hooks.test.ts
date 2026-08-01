import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { installHooks, uninstallHooks, resolveHooksDir } from "./hooks.js";
import { checkHooks, isGitRepository } from "./check-hooks.js";
import type { HooksConfig } from "./config.js";

describe("installHooks", () => {
  const testGitDir = join(tmpdir(), `.test-git-${process.pid}`);

  afterEach(async () => {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(testGitDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates hooks directory if it doesn't exist", async () => {
    const config: HooksConfig = {
      "pre-commit": ["npm run lint"],
    };

    const results = await installHooks(config, testGitDir);

    // installHooks always appends the bypass-detector pair (sentinel writer
    // + post-commit detector). Assert against the named hook from config.
    const preCommit = results.find((r) => r.hookName === "pre-commit");
    assert.ok(preCommit, "pre-commit result present");
    assert.ok(preCommit.action === "installed" || preCommit.action === "updated");
    assert.ok(existsSync(join(testGitDir, "hooks", "pre-commit")));
    // The bypass detector also writes a post-commit hook unconditionally.
    assert.ok(existsSync(join(testGitDir, "hooks", "post-commit")));
  });

  it("does not overwrite a hook kit did not generate", async () => {
    const hooksDir = join(testGitDir, "hooks");
    await mkdir(hooksDir, { recursive: true });
    const foreign = "#!/bin/sh\necho 'my own pre-push gate'\nexit 0\n";
    await writeFile(join(hooksDir, "pre-push"), foreign, "utf-8");

    const results = await installHooks({ "pre-push": ["kit context check"] }, testGitDir);

    const pp = results.find((r) => r.hookName === "pre-push");
    assert.equal(pp?.action, "skipped");
    assert.ok(pp?.detail.includes("non-kit"));
    // The operator's hook is untouched.
    assert.equal(await readFile(join(hooksDir, "pre-push"), "utf-8"), foreign);
  });

  it("installs multiple hooks", async () => {
    const config: HooksConfig = {
      "pre-commit": ["npm run lint", "npm run typecheck"],
      "pre-push": ["npm audit --audit-level=high"],
    };

    const results = await installHooks(config, testGitDir);

    const configured = results.filter(
      (r) => r.hookName === "pre-commit" || r.hookName === "pre-push",
    );
    assert.equal(configured.length, 2);
    assert.ok(existsSync(join(testGitDir, "hooks", "pre-commit")));
    assert.ok(existsSync(join(testGitDir, "hooks", "pre-push")));

    // Verify pre-commit has both commands
    const preCommitContent = await readFile(join(testGitDir, "hooks", "pre-commit"), "utf-8");
    assert.ok(preCommitContent.includes("npm run lint"));
    assert.ok(preCommitContent.includes("npm run typecheck"));

    // Verify pre-push has audit command
    const prePushContent = await readFile(join(testGitDir, "hooks", "pre-push"), "utf-8");
    assert.ok(prePushContent.includes("npm audit --audit-level=high"));
  });

  it("frames each command as a numbered step with live markers + timing", async () => {
    const config: HooksConfig = {
      "pre-commit": ["npm run build", "npm test"],
    };

    await installHooks(config, testGitDir);
    const content = await readFile(join(testGitDir, "hooks", "pre-commit"), "utf-8");

    // Numbered step markers (▶ / ✓ / ✗) for each of the 2 commands
    assert.ok(content.includes("▶ [1/2] npm run build"));
    assert.ok(content.includes("▶ [2/2] npm test"));
    assert.ok(content.includes("✓ [1/2] npm run build"));
    // Per-step + total duration via date arithmetic
    assert.ok(content.includes("$(date +%s)"));
    assert.ok(content.includes("step(s) in"));
    // Commands still executed verbatim (so check-hooks up-to-date detection holds)
    assert.ok(content.includes("if npm run build; then"));
  });

  it("makes hook files executable", async () => {
    const config: HooksConfig = {
      "pre-commit": ["echo test"],
    };

    await installHooks(config, testGitDir);

    const hookPath = join(testGitDir, "hooks", "pre-commit");
    // NTFS has no POSIX execute bit, so chmod(0o755) is a no-op on native Windows
    // and stat().mode never carries 0o111. Git for Windows runs the hook via its
    // bundled `sh` regardless of the exec bit, so on win32 we assert the hook was
    // written instead of the (meaningless) mode bits. #43.
    if (process.platform === "win32") {
      assert.ok(existsSync(hookPath));
    } else {
      const { stat } = await import("node:fs/promises");
      const stats = await stat(hookPath);
      // Check if file is executable (mode should include 0o100)
      assert.ok((stats.mode & 0o111) !== 0);
    }
  });

  it("updates existing hooks", async () => {
    const config1: HooksConfig = {
      "pre-commit": ["echo old"],
    };

    const results1 = await installHooks(config1, testGitDir);
    assert.equal(results1[0].action, "installed");

    const config2: HooksConfig = {
      "pre-commit": ["echo new"],
    };

    const results2 = await installHooks(config2, testGitDir);
    assert.equal(results2[0].action, "updated");

    const content = await readFile(join(testGitDir, "hooks", "pre-commit"), "utf-8");
    assert.ok(content.includes("echo new"));
    assert.ok(!content.includes("echo old"));
  });

  it("skips empty command arrays", async () => {
    const config: HooksConfig = {
      "pre-commit": [],
      "pre-push": ["npm audit"],
    };

    const results = await installHooks(config, testGitDir);

    // Bypass detector still installs its sentinel pair even when no
    // configured hooks come from the user — that's the point: skip
    // detection must always run. So we only assert about the configured
    // names.
    const configured = results.filter(
      (r) => r.hookName === "pre-commit" || r.hookName === "pre-push",
    );
    assert.equal(configured.length, 1);
    assert.equal(configured[0].hookName, "pre-push");
  });

  it("includes kit marker in generated hooks", async () => {
    const config: HooksConfig = {
      "pre-commit": ["echo test"],
    };

    await installHooks(config, testGitDir);

    const content = await readFile(join(testGitDir, "hooks", "pre-commit"), "utf-8");
    assert.ok(content.includes("# Generated by kit"));
  });
});

describe("checkHooks", () => {
  const testGitDir = join(tmpdir(), `.test-git-check-${process.pid}`);

  afterEach(async () => {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(testGitDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("reports not installed when hooks don't exist", async () => {
    const config: HooksConfig = {
      "pre-commit": ["npm run lint"],
    };

    await mkdir(join(testGitDir, "hooks"), { recursive: true });

    const results = await checkHooks(config, testGitDir);

    assert.equal(results.length, 1);
    assert.equal(results[0].hookName, "pre-commit");
    assert.equal(results[0].installed, false);
    assert.equal(results[0].upToDate, false);
  });

  it("reports up-to-date when hooks match config", async () => {
    const config: HooksConfig = {
      "pre-commit": ["npm run lint"],
    };

    await installHooks(config, testGitDir);

    const results = await checkHooks(config, testGitDir);

    assert.equal(results.length, 1);
    assert.equal(results[0].hookName, "pre-commit");
    assert.equal(results[0].installed, true);
    assert.equal(results[0].upToDate, true);
  });

  it("reports outdated when hook commands don't match", async () => {
    const oldConfig: HooksConfig = {
      "pre-commit": ["npm run lint"],
    };

    await installHooks(oldConfig, testGitDir);

    const newConfig: HooksConfig = {
      "pre-commit": ["npm run lint", "npm run typecheck"],
    };

    const results = await checkHooks(newConfig, testGitDir);

    assert.equal(results.length, 1);
    assert.equal(results[0].installed, true);
    assert.equal(results[0].upToDate, false);
  });

  it("reports not managed by kit for non-kit hooks", async () => {
    const config: HooksConfig = {
      "pre-commit": ["npm run lint"],
    };

    // Create a non-kit hook
    await mkdir(join(testGitDir, "hooks"), { recursive: true });
    await writeFile(
      join(testGitDir, "hooks", "pre-commit"),
      "#!/bin/sh\necho manual hook\n",
      "utf-8",
    );

    const results = await checkHooks(config, testGitDir);

    assert.equal(results.length, 1);
    assert.equal(results[0].installed, true);
    assert.equal(results[0].upToDate, false);
    assert.ok(results[0].detail.includes("not managed by kit"));
  });
});

describe("uninstallHooks", () => {
  const testGitDir = join(tmpdir(), `.test-git-uninstall-${process.pid}`);

  afterEach(async () => {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(testGitDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("removes installed hooks", async () => {
    const config: HooksConfig = {
      "pre-commit": ["echo test"],
    };

    await installHooks(config, testGitDir);
    assert.ok(existsSync(join(testGitDir, "hooks", "pre-commit")));

    const results = await uninstallHooks(["pre-commit"], testGitDir);

    assert.equal(results.length, 1);
    assert.equal(results[0].hookName, "pre-commit");
    assert.ok(!existsSync(join(testGitDir, "hooks", "pre-commit")));
  });

  it("skips hooks that don't exist", async () => {
    await mkdir(join(testGitDir, "hooks"), { recursive: true });

    const results = await uninstallHooks(["pre-commit"], testGitDir);

    assert.equal(results.length, 1);
    assert.equal(results[0].action, "skipped");
    assert.ok(results[0].detail.includes("not found"));
  });
});

describe("isGitRepository", () => {
  it("returns false for non-existent directory", () => {
    const result = isGitRepository("/nonexistent/path/.git");
    assert.equal(result, false);
  });
});

describe("resolveHooksDir", () => {
  it("honors core.hooksPath so installed hooks actually run", async () => {
    const repo = await mkdtemp(join(tmpdir(), "kit-hookpath-"));
    try {
      execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
      execFileSync("git", ["-C", repo, "config", "core.hooksPath", "myhooks"], { stdio: "ignore" });
      assert.equal(resolveHooksDir(join(repo, ".git")), join(repo, "myhooks"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("falls back to <gitDir>/hooks when hooksPath is unset", async () => {
    const repo = await mkdtemp(join(tmpdir(), "kit-nohookpath-"));
    try {
      execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
      assert.equal(resolveHooksDir(join(repo, ".git")), join(repo, ".git", "hooks"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

/**
 * `uninstallHooks` removes enforcement — the gates `kit check` relies on. These
 * cases pin the parts a refactor would most plausibly get wrong: the per-name
 * result contract the CLI renders positionally, the error/absent branches, and
 * the deletions it performs WITHOUT the guards `installHooks` has.
 * Documented as-is; suspicions are reported, not asserted as wishes.
 */
describe("uninstallHooks — result contract and destructive edges", () => {
  /** Fresh throwaway `<tmp>/.git/hooks` per test; caller removes it. */
  async function fixture(): Promise<{ base: string; gitDir: string; hooksDir: string }> {
    const base = await mkdtemp(join(tmpdir(), "kit-hooks-uninstall-"));
    const gitDir = join(base, ".git");
    const hooksDir = join(gitDir, "hooks");
    await mkdir(hooksDir, { recursive: true });
    return { base, gitDir, hooksDir };
  }

  it("returns exactly one result per requested name, in request order", async () => {
    const { base, gitDir, hooksDir } = await fixture();
    try {
      await writeFile(join(hooksDir, "pre-push"), "#!/bin/sh\n", "utf-8");

      const results = await uninstallHooks(["pre-commit", "pre-push", "commit-msg"], gitDir);

      // `kit hooks uninstall` prints one line per result and pairs it with the
      // requested name by position, so a dropped/reordered entry mislabels which
      // gate is gone. Absent hooks must still produce a placeholder result.
      assert.deepEqual(
        results.map((r) => r.hookName),
        ["pre-commit", "pre-push", "commit-msg"],
      );
      assert.deepEqual(
        results.map((r) => r.action),
        ["skipped", "installed", "skipped"],
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('signals a successful removal as action "installed" with detail "uninstalled"', async () => {
    const { base, gitDir, hooksDir } = await fixture();
    try {
      await writeFile(join(hooksDir, "pre-commit"), "#!/bin/sh\n# Generated by kit\n", "utf-8");

      const [res] = await uninstallHooks(["pre-commit"], gitDir);

      // Deliberately odd: removal reuses the "installed" action. Callers branch on
      // it (src/commands/hooks.ts relabels it "removed"), so "flipping" this to a
      // saner value is a breaking change, not a cleanup — pinned here on purpose.
      assert.equal(res.action, "installed");
      assert.equal(res.detail, "uninstalled");
      assert.ok(!existsSync(join(hooksDir, "pre-commit")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("deletes a hook kit did not generate, without any provenance check", async () => {
    const { base, gitDir, hooksDir } = await fixture();
    try {
      await writeFile(join(hooksDir, "pre-push"), "#!/bin/sh\necho 'my own gate'\n", "utf-8");

      const [res] = await uninstallHooks(["pre-push"], gitDir);

      // Asymmetry with installHooks, which refuses to overwrite a hook lacking the
      // "Generated by kit" marker. Uninstall has no such guard: an operator-authored
      // hook is removed. Asserting the ACTUAL behaviour so a future guard has to be
      // an intentional, visible change to this test.
      assert.equal(res.action, "installed");
      assert.ok(!existsSync(join(hooksDir, "pre-push")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("removes only the named hooks, leaving the bypass-detector pair behind", async () => {
    const { base, gitDir, hooksDir } = await fixture();
    try {
      await installHooks({ "pre-push": ["npm audit"] }, gitDir);
      assert.ok(existsSync(join(hooksDir, "post-commit")));

      await uninstallHooks(["pre-push"], gitDir);

      // installHooks writes the sentinel pair unconditionally; uninstall does NOT
      // infer them. This is why the CLI has to add pre-commit/post-commit to the
      // removal list itself — a half-removed pair makes post-commit report every
      // later commit as a --no-verify bypass forever.
      assert.ok(existsSync(join(hooksDir, "post-commit")));
      assert.ok(existsSync(join(hooksDir, "pre-commit")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("is idempotent for a repeated name within one call", async () => {
    const { base, gitDir, hooksDir } = await fixture();
    try {
      await writeFile(join(hooksDir, "pre-commit"), "#!/bin/sh\n", "utf-8");

      const results = await uninstallHooks(["pre-commit", "pre-commit"], gitDir);

      // The CLI de-dupes with a Set, but a duplicate reaching here must not turn the
      // second pass into a "failed" (ENOENT) and fail the whole command.
      assert.equal(results[0].action, "installed");
      assert.equal(results[1].action, "skipped");
      assert.equal(results[1].detail, "not found");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("returns an empty list for no names and never creates the hooks directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "kit-hooks-uninstall-empty-"));
    const gitDir = join(base, ".git");
    try {
      assert.deepEqual(await uninstallHooks([], gitDir), []);

      // Unlike installHooks, uninstall must not mkdir anything: reporting "not found"
      // for a repo with no hooks dir is the correct read-only outcome.
      const results = await uninstallHooks(["pre-commit"], gitDir);
      assert.equal(results[0].action, "skipped");
      assert.equal(results[0].detail, "not found");
      assert.ok(!existsSync(join(gitDir, "hooks")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("reports a failure instead of throwing when the hook path is a directory", async () => {
    const { base, gitDir, hooksDir } = await fixture();
    try {
      await mkdir(join(hooksDir, "pre-commit"), { recursive: true });

      const results = await uninstallHooks(["pre-commit", "pre-push"], gitDir);

      // Never throw: one unremovable entry must not abort the remaining names, and
      // the reason has to reach the operator rather than a stack trace.
      assert.equal(results[0].action, "failed");
      assert.ok(results[0].detail.length > 0);
      assert.equal(results[1].action, "skipped");
      assert.ok(existsSync(join(hooksDir, "pre-commit")));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("resolves names against the hooks dir, so a traversing name escapes it", async () => {
    const { base, gitDir } = await fixture();
    try {
      const outside = join(gitDir, "kit-uninstall-traversal-target");
      await writeFile(outside, "not a hook\n", "utf-8");

      const [res] = await uninstallHooks(["../kit-uninstall-traversal-target"], gitDir);

      // Hook names come from `.kit.toml [hooks]` keys, and resolve() lets one climb
      // out of the hooks dir and unlink an arbitrary file. Documented as the current
      // behaviour, not endorsed — see notes.
      assert.equal(res.action, "installed");
      assert.ok(!existsSync(outside));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("still deletes hooks while read-only mode is active", async () => {
    const { base, gitDir, hooksDir } = await fixture();
    const prior = process.env.KIT_READ_ONLY;
    try {
      await writeFile(join(hooksDir, "pre-commit"), "#!/bin/sh\n", "utf-8");
      process.env.KIT_READ_ONLY = "1";

      const [res] = await uninstallHooks(["pre-commit"], gitDir);

      // installHooks refuses + audits under KIT_READ_ONLY; uninstall has no such
      // check, so read-only mode does not stop enforcement from being torn down.
      // Actual behaviour pinned; flagged in notes as a probable gap.
      assert.equal(res.action, "installed");
      assert.ok(!existsSync(join(hooksDir, "pre-commit")));
    } finally {
      if (prior === undefined) delete process.env.KIT_READ_ONLY;
      else process.env.KIT_READ_ONLY = prior;
      await rm(base, { recursive: true, force: true });
    }
  });
});
