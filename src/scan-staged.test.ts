import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStagedFiles } from "./scan-staged.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function tmpGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-scan-staged-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  return dir;
}

describe("scanStagedFiles", () => {
  it("returns empty when no files are staged", async () => {
    const dir = tmpGitRepo();
    try {
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmTemp(dir);
    }
  });

  it("returns empty for staged files without secrets", async () => {
    const dir = tmpGitRepo();
    try {
      writeFileSync(join(dir, "README.md"), "# Project\n\nNothing to see here.\n");
      execSync("git add README.md", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmTemp(dir);
    }
  });

  it("flags a staged Stripe key", async () => {
    const dir = tmpGitRepo();
    try {
      writeFileSync(
        join(dir, ".env"),
        "STRIPE_SECRET_KEY=sk_te" + "st_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy\n",
      );
      execSync("git add .env", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].file, ".env");
      assert.ok(hits[0].findings.some((f) => f.label === "stripe-key"));
    } finally {
      rmTemp(dir);
    }
  });

  it("scans the STAGED blob, not the working copy (secret survives a working-copy cleanup)", async () => {
    const dir = tmpGitRepo();
    try {
      // Stage a secret, then edit the working copy to remove it. The scanner must still flag the
      // staged blob — it must NOT read the (now-clean) working copy. This is the un-stage bypass
      // the fix hardens (the working-copy fallback was removed for divergent reads).
      writeFileSync(
        join(dir, ".env"),
        "STRIPE_SECRET_KEY=sk_te" + "st_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy\n",
      );
      execSync("git add .env", { cwd: dir });
      writeFileSync(join(dir, ".env"), "STRIPE_SECRET_KEY=redacted\n"); // working copy cleaned
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((f) => f.label === "stripe-key"));
    } finally {
      rmTemp(dir);
    }
  });

  it("flags a staged Supabase service-role JWT", async () => {
    const dir = tmpGitRepo();
    try {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36";
      writeFileSync(join(dir, ".env.local"), `SERVICE_ROLE=${jwt}\n`);
      execSync("git add .env.local", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((f) => f.label === "jwt"));
    } finally {
      rmTemp(dir);
    }
  });

  it("flags multiple files in one scan", async () => {
    const dir = tmpGitRepo();
    try {
      writeFileSync(join(dir, "a.env"), "STRIPE_KEY=sk_te" + "st_AAAAAAAAAAAAAAAAAAAA\n");
      writeFileSync(join(dir, "b.txt"), "AKIA01234567890ABCDE\n");
      execSync("git add a.env b.txt", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 2);
    } finally {
      rmTemp(dir);
    }
  });

  it("returns empty when not in a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-no-git-"));
    try {
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scanStagedFiles: a staged gitlink", () => {
  /** A repo with a nested repo that has one commit, so `git add inner` stages a gitlink (mode 160000). */
  function repoWithNestedRepo(): string {
    const dir = tmpGitRepo();
    const inner = join(dir, "inner");
    mkdirSync(inner);
    execSync("git init -q", { cwd: inner });
    execSync("git config user.email t@t", { cwd: inner });
    execSync("git config user.name t", { cwd: inner });
    writeFileSync(join(inner, "a.txt"), "hello\n");
    execSync("git add a.txt && git commit -q -m first", { cwd: inner });
    return dir;
  }

  it("does not block on a nested repo, which is scanned in its own repo", async () => {
    const dir = repoWithNestedRepo();
    try {
      execSync("git add inner", { cwd: dir });
      assert.match(execSync("git ls-files --stage inner", { cwd: dir }).toString(), /^160000 /);
      assert.deepEqual(await scanStagedFiles(dir), []);
    } finally {
      rmTemp(dir);
    }
  });

  it("still flags a secret staged next to the nested repo, and names only that file", async () => {
    const dir = repoWithNestedRepo();
    try {
      writeFileSync(
        join(dir, ".env"),
        "STRIPE_SECRET_KEY=sk_te" + "st_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy\n",
      );
      execSync("git add inner .env", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.deepEqual(
        hits.map((h) => h.file),
        [".env"],
      );
    } finally {
      rmTemp(dir);
    }
  });
});
