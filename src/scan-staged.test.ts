import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStagedFiles } from "./scan-staged.js";

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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a staged Stripe key", async () => {
    const dir = tmpGitRepo();
    try {
      writeFileSync(
        join(dir, ".env"),
        "STRIPE_SECRET_KEY=sk_te"+"st_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy\n",
      );
      execSync("git add .env", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].file, ".env");
      assert.ok(hits[0].findings.some((f) => f.label === "stripe-key"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a staged Supabase service-role JWT", async () => {
    const dir = tmpGitRepo();
    try {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36";
      writeFileSync(join(dir, ".env.local"), `SERVICE_ROLE=${jwt}\n`);
      execSync("git add .env.local", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].findings.some((f) => f.label === "jwt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags multiple files in one scan", async () => {
    const dir = tmpGitRepo();
    try {
      writeFileSync(join(dir, "a.env"), "STRIPE_KEY=sk_te"+"st_AAAAAAAAAAAAAAAAAAAA\n");
      writeFileSync(join(dir, "b.txt"), "AKIA01234567890ABCDE\n");
      execSync("git add a.env b.txt", { cwd: dir });
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty when not in a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-no-git-"));
    try {
      const hits = await scanStagedFiles(dir);
      assert.equal(hits.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
