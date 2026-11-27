/**
 * Aider skips git hooks unless `git-commit-verify` is on. Fixture facts are from Aider-AI/aider at
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c: `aider/args.py:491-496` (default False) and
 * `aider/repo.py:278-279` (`--no-verify` appended when false).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiderCommitVerify, checkAiderCommitVerify } from "./check-aider-commit-verify.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function dirs(): { root: string; home: string } {
  return {
    root: mkdtempSync(join(tmpdir(), "kit-aider-")),
    home: mkdtempSync(join(tmpdir(), "kit-aider-home-")),
  };
}

describe("aiderCommitVerify", () => {
  it("reads YAML 1.1 booleans and ignores comments", () => {
    assert.equal(aiderCommitVerify("git-commit-verify: true\n"), true);
    assert.equal(aiderCommitVerify("git-commit-verify: yes # hooks\n"), true);
    assert.equal(aiderCommitVerify("git-commit-verify: false\n"), false);
    assert.equal(aiderCommitVerify("model: x\n"), undefined);
    assert.equal(aiderCommitVerify("# git-commit-verify: true\n"), undefined);
  });
});

describe("checkAiderCommitVerify", () => {
  it("warns when a repo has Aider config without git-commit-verify", () => {
    const { root, home } = dirs();
    try {
      writeFileSync(join(root, ".aider.conf.yml"), "read:\n  - CONVENTIONS.md\n");
      const rows = checkAiderCommitVerify(root, home, {});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "warn");
      assert.match(rows[0].detail, /--no-verify/);
      assert.match(rows[0].suggestion ?? "", /git-commit-verify: true/);
    } finally {
      rmTemp(root);
      rmTemp(home);
    }
  });

  it("passes when the repo config, the home config or the env turns it on", () => {
    const { root, home } = dirs();
    try {
      writeFileSync(join(root, ".aider.chat.history.md"), "");
      assert.equal(checkAiderCommitVerify(root, home, {})[0].status, "warn");
      assert.equal(
        checkAiderCommitVerify(root, home, { AIDER_GIT_COMMIT_VERIFY: "true" })[0].status,
        "pass",
      );
      writeFileSync(join(home, ".aider.conf.yml"), "git-commit-verify: true\n");
      assert.equal(checkAiderCommitVerify(root, home, {})[0].status, "pass");
      // the repo file outranks the home file
      writeFileSync(join(root, ".aider.conf.yml"), "git-commit-verify: false\n");
      assert.equal(checkAiderCommitVerify(root, home, {})[0].status, "warn");
    } finally {
      rmTemp(root);
      rmTemp(home);
    }
  });

  it("gives no row when the repo shows no sign of Aider", () => {
    const { root, home } = dirs();
    try {
      assert.deepEqual(checkAiderCommitVerify(root, home, {}), []);
    } finally {
      rmTemp(root);
      rmTemp(home);
    }
  });
});
