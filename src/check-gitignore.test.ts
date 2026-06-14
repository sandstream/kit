import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  checkGitignore,
  patchGitignore,
  findCommittedSensitive,
} from "./check-gitignore.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-gi-"));
}

describe("checkGitignore", () => {
  it("reports exists=false when .gitignore is missing", async () => {
    const dir = tmpRepo();
    try {
      const r = await checkGitignore(dir);
      assert.equal(r.exists, false);
      assert.ok(r.missingPatterns.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags every missing pattern when .gitignore is empty", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# nothing here\n");
      const r = await checkGitignore(dir);
      assert.equal(r.exists, true);
      assert.equal(r.presentPatterns.length, 0);
      assert.ok(r.missingPatterns.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes aliases (e.g. .env* covers .env + .env.local)", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), ".env*\n");
      const r = await checkGitignore(dir);
      // .env, .env.local, .env.*.local all covered by .env*
      const stillMissing = r.missingPatterns.map((m) => m.pattern);
      assert.ok(!stillMissing.includes(".env"));
      assert.ok(!stillMissing.includes(".env.local"));
      assert.ok(!stillMissing.includes(".env.*.local"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores comments and blank lines", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(
        join(dir, ".gitignore"),
        "\n# comment\n.env\n  # indented comment\n\n",
      );
      const r = await checkGitignore(dir);
      // .env is present, .env.local is not (no alias for bare `.env`)
      const stillMissing = r.missingPatterns.map((m) => m.pattern);
      assert.ok(!stillMissing.includes(".env"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("patchGitignore", () => {
  it("creates .gitignore when missing", async () => {
    const dir = tmpRepo();
    try {
      const r = await patchGitignore(dir);
      assert.equal(r.written, true);
      assert.ok(r.added > 0);
      const text = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.ok(text.includes(".env"));
      assert.ok(text.includes("node_modules"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends to an existing file without rewriting other lines", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "# my stuff\nmy-file\n");
      await patchGitignore(dir);
      const text = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.ok(text.includes("my-file")); // original preserved
      assert.ok(text.includes("kit security check-gitignore")); // marker present
      assert.ok(text.includes("node_modules"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — re-running replaces the kit block, not stacks it", async () => {
    const dir = tmpRepo();
    try {
      await patchGitignore(dir);
      const first = readFileSync(join(dir, ".gitignore"), "utf-8");
      await patchGitignore(dir);
      const second = readFileSync(join(dir, ".gitignore"), "utf-8");
      // Same number of marker-start tokens (exactly 1) both times
      const count = (s: string) =>
        (s.match(/kit security check-gitignore/g) || []).length;
      assert.equal(count(first), 1);
      assert.equal(count(second), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns added=0 when nothing is missing", async () => {
    const dir = tmpRepo();
    try {
      await patchGitignore(dir);
      const second = await patchGitignore(dir);
      assert.equal(second.added, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findCommittedSensitive", () => {
  it("returns [] when not a git repo", async () => {
    const dir = tmpRepo();
    try {
      const r = await findCommittedSensitive(dir);
      assert.deepEqual(r, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds .env / *.pem / id_rsa already tracked in git", async () => {
    const dir = tmpRepo();
    try {
      execSync("git init -q", { cwd: dir });
      execSync("git config user.email t@t", { cwd: dir });
      execSync("git config user.name t", { cwd: dir });
      writeFileSync(join(dir, ".env"), "SECRET=value");
      writeFileSync(join(dir, "deploy.pem"), "-----BEGIN-----");
      writeFileSync(join(dir, "README.md"), "# safe");
      execSync("git add . && git commit -q -m init", { cwd: dir });
      const r = await findCommittedSensitive(dir);
      assert.ok(r.includes(".env"));
      assert.ok(r.includes("deploy.pem"));
      assert.ok(!r.includes("README.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doesn't flag .env.template / .env.example", async () => {
    const dir = tmpRepo();
    try {
      execSync("git init -q", { cwd: dir });
      execSync("git config user.email t@t", { cwd: dir });
      execSync("git config user.name t", { cwd: dir });
      writeFileSync(join(dir, ".env.template"), "STRIPE_SECRET_KEY=");
      writeFileSync(join(dir, ".env.example"), "STRIPE_SECRET_KEY=");
      execSync("git add . && git commit -q -m init", { cwd: dir });
      const r = await findCommittedSensitive(dir);
      assert.equal(r.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
