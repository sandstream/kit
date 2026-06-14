import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { installHooks, uninstallHooks } from "./hooks.js";
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
    assert.ok(
      preCommit.action === "installed" || preCommit.action === "updated",
    );
    assert.ok(existsSync(join(testGitDir, "hooks", "pre-commit")));
    // The bypass detector also writes a post-commit hook unconditionally.
    assert.ok(existsSync(join(testGitDir, "hooks", "post-commit")));
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
    const preCommitContent = await readFile(
      join(testGitDir, "hooks", "pre-commit"),
      "utf-8",
    );
    assert.ok(preCommitContent.includes("npm run lint"));
    assert.ok(preCommitContent.includes("npm run typecheck"));

    // Verify pre-push has audit command
    const prePushContent = await readFile(
      join(testGitDir, "hooks", "pre-push"),
      "utf-8",
    );
    assert.ok(prePushContent.includes("npm audit --audit-level=high"));
  });

  it("frames each command as a numbered step with live markers + timing", async () => {
    const config: HooksConfig = {
      "pre-commit": ["npm run build", "npm test"],
    };

    await installHooks(config, testGitDir);
    const content = await readFile(
      join(testGitDir, "hooks", "pre-commit"),
      "utf-8",
    );

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
    const { stat } = await import("node:fs/promises");
    const stats = await stat(hookPath);

    // Check if file is executable (mode should include 0o100)
    assert.ok((stats.mode & 0o111) !== 0);
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

    const content = await readFile(
      join(testGitDir, "hooks", "pre-commit"),
      "utf-8",
    );
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

    const content = await readFile(
      join(testGitDir, "hooks", "pre-commit"),
      "utf-8",
    );
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
