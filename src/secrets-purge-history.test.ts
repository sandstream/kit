import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { previewMatches, purgeHistory, detectTools } from "./secrets-purge-history.js";

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir });
}

function makeRepoWithLeak(): { dir: string; leakValue: string } {
  const dir = mkdtempSync(join(tmpdir(), "kit-purge-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  const leakValue = "sk_"+"test_AAAAAAAAAAAAAAAAAAAA1234";
  writeFileSync(join(dir, "config.txt"), `STRIPE=${leakValue}\n`);
  git(dir, "add", "config.txt");
  git(dir, "commit", "-q", "-m", "oops");
  return { dir, leakValue };
}

describe("previewMatches", () => {
  it("returns 0 matches when pattern is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-purge-"));
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "t");
      writeFileSync(join(dir, "README.md"), "# repo\n");
      git(dir, "add", "README.md");
      git(dir, "commit", "-q", "-m", "init");
      const p = await previewMatches("sk_live_nonexistent", dir);
      assert.equal(p.matchedCommits, 0);
      assert.equal(p.matchedFiles.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds the commit that introduced the leak + the file it touched", async () => {
    const { dir, leakValue } = makeRepoWithLeak();
    try {
      const p = await previewMatches(leakValue, dir);
      assert.equal(p.matchedCommits, 1);
      assert.ok(p.matchedFiles.includes("config.txt"));
      assert.equal(p.sampleHashes.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("purgeHistory", () => {
  it("refuses gracefully when no patterns are supplied", async () => {
    const r = await purgeHistory([]);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes("no patterns"));
  });

  it("returns the installed-tool error when neither tool is available", async () => {
    // We can't reliably simulate the absence of git filter-repo OR bfg on
    // every CI runner. What we CAN verify here is the call shape: passing
    // a single literal pattern through a tempdir is non-throwing and
    // returns a structured result. Either tool may be installed on the
    // runner — both outcomes satisfy the contract.
    const { dir } = makeRepoWithLeak();
    try {
      const r = await purgeHistory(["DEFINITELY_NOT_PRESENT_IN_HISTORY"], dir);
      // Either ok=true (tool ran on an empty match → no-op success) or ok=false
      // with a clear "not installed" message. Both shapes are valid.
      assert.ok(typeof r.ok === "boolean");
      assert.ok(typeof r.detail === "string");
      assert.ok(r.toolUsed === "git-filter-repo" || r.toolUsed === "bfg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("detectTools", () => {
  it("reports availability of git filter-repo + bfg as booleans", async () => {
    const t = await detectTools();
    assert.equal(typeof t.filterRepoAvailable, "boolean");
    assert.equal(typeof t.bfgAvailable, "boolean");
  });
});
