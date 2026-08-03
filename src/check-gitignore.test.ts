import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { checkGitignore, patchGitignore, findCommittedSensitive } from "./check-gitignore.js";

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
      writeFileSync(join(dir, ".gitignore"), "\n# comment\n.env\n  # indented comment\n\n");
      const r = await checkGitignore(dir);
      // .env is present, .env.local is not (no alias for bare `.env`)
      const stillMissing = r.missingPatterns.map((m) => m.pattern);
      assert.ok(!stillMissing.includes(".env"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * THE ORACLE IS GIT. Everything else in this file asks kit whether kit thinks a pattern is
 * present, which is exactly the loop that let the real defect live: `--fix` wrote
 * `.env  # default dotenv file`, the parser stripped the annotation back off, kit reported
 * 13/13 covered, and `git check-ignore .env` matched nothing — `.gitignore` has no
 * trailing-comment syntax, so each line was a literal pattern containing " # reason".
 *
 * These tests shell out to real git in a real repo. If kit's idea of "ignored" ever drifts from
 * git's again, this fails, regardless of what kit's own parser believes.
 */
describe("patched .gitignore is honored by GIT, not just by kit", () => {
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "kit-gi-git-"));
    execSync("git init -q .", { cwd: dir });
    return dir;
  }

  /** True when git itself ignores `path` in `cwd`. `git check-ignore` exits 1 for "not ignored". */
  function gitIgnores(cwd: string, path: string): boolean {
    try {
      execSync(`git check-ignore -q -- ${JSON.stringify(path)}`, { cwd, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  it("git ignores the files the patched block claims to cover", async () => {
    const dir = gitRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "node_modules\n");
      const r = await patchGitignore(dir);
      assert.ok(r.written, "expected a patch");

      // One representative file per shape kit promises to cover.
      const shouldBeIgnored = [
        ".env",
        ".env.local",
        ".env.production.local",
        ".kit/elevation.json",
        ".kit-audit.jsonl",
        "server.pem",
        "server.key",
        "id_rsa",
        "id_ed25519",
        "bundle.p12",
        "gcp-service-account-prod.json",
      ];
      const notIgnored = shouldBeIgnored.filter((p) => !gitIgnores(dir, p));
      assert.deepEqual(
        notIgnored,
        [],
        `kit claims to cover these but git does not ignore them: ${notIgnored.join(", ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the curated shared-memory tier stays TRACKED (the negation survives)", async () => {
    // `.kit/*` + `!.kit/shared/` is deliberate: a wholesale `.kit/` would stop git descending
    // and the negation could never re-include the committed-by-design shared tier.
    const dir = gitRepo();
    try {
      await patchGitignore(dir);
      assert.equal(gitIgnores(dir, ".kit/elevation.json"), true, "local state must be ignored");
      assert.equal(
        gitIgnores(dir, ".kit/shared/memory.jsonl"),
        false,
        "curated shared memory must stay tracked",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a pattern carrying an inline comment is NOT counted as present", async () => {
    // The exact shape kit used to write. git treats the whole line as one literal pattern, so
    // kit must not read it as coverage — otherwise old broken files keep reporting green.
    const dir = gitRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "*.pem  # PEM keys / certs\n");
      assert.equal(gitIgnores(dir, "server.pem"), false, "sanity: git does not honor this line");
      const r = await checkGitignore(dir);
      assert.ok(
        r.missingPatterns.some((m) => m.pattern === "*.pem"),
        "an inline-commented pattern must count as MISSING, since git ignores nothing",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-patching a file written in the OLD broken form repairs it", async () => {
    // Migration: anyone who already ran --fix has a block full of inert lines. The block is
    // marker-delimited, so a re-run replaces it — and git must honor the result.
    const dir = gitRepo();
    try {
      writeFileSync(
        join(dir, ".gitignore"),
        [
          "node_modules",
          "",
          "# ── kit security check-gitignore ── do not edit ──",
          ".env  # default dotenv file",
          "*.pem  # PEM keys / certs",
          "# ── /kit ──",
          "",
        ].join("\n"),
      );
      assert.equal(gitIgnores(dir, ".env"), false, "sanity: the old form ignores nothing");
      const r = await patchGitignore(dir);
      assert.ok(r.written, "a broken block must be recognised as needing a patch");
      assert.equal(gitIgnores(dir, ".env"), true);
      assert.equal(gitIgnores(dir, "server.pem"), true);
      // Per LINE, never over the whole file: `\s` matches newlines, so a whole-file regex
      // happily matches "pattern\n# comment" and reports a trailing comment that isn't there.
      const text = readFileSync(join(dir, ".gitignore"), "utf-8");
      const offenders = text
        .split("\n")
        .filter((l) => l.trim() && !l.trimStart().startsWith("#") && /\s#/.test(l));
      assert.deepEqual(offenders, [], "a pattern line must not carry a trailing comment");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("patching is idempotent — a second run adds nothing", async () => {
    const dir = gitRepo();
    try {
      await patchGitignore(dir);
      const first = readFileSync(join(dir, ".gitignore"), "utf-8");
      const second = await patchGitignore(dir);
      assert.equal(second.added, 0, "nothing should be missing after a correct patch");
      assert.equal(second.written, false);
      assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), first);
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
      const count = (s: string) => (s.match(/kit security check-gitignore/g) || []).length;
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

  it("ignores .kit contents via .kit/* and re-includes the curated shared tier", async () => {
    const dir = tmpRepo();
    try {
      await patchGitignore(dir);
      const text = readFileSync(join(dir, ".gitignore"), "utf-8");
      // Must use the descendable `.kit/*` form, never the wholesale `.kit/`
      // (which would make the `!.kit/shared/` negation a no-op).
      const lines = text.split("\n").map((l) => l.split("#")[0].trim());
      assert.ok(lines.includes(".kit/*"), "expected .kit/* contents-ignore");
      assert.ok(!lines.includes(".kit/"), "must not emit wholesale .kit/");
      assert.ok(lines.includes("!.kit/shared/"), "expected shared re-include");
      // Order matters: the negation must come AFTER .kit/*.
      assert.ok(
        lines.indexOf("!.kit/shared/") > lines.indexOf(".kit/*"),
        "negation must follow .kit/*",
      );
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
