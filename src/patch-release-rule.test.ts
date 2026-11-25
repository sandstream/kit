/**
 * A patch release is bug fixes only: CHANGELOG.md's "Semantic Versioning" says so, and 10 of 37
 * patch sections had `### Added` anyway (kit-research `linus-fixes-add-bugs-vs-kit`). `assemble`
 * and the publish job's `check --none-left` now refuse it for the version being released, and the
 * release prep names the fixes that rewrite another fix since the previous tag.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENTS = join(REPO_ROOT, "scripts", "changelog-fragments.mjs");
const FIX_OF_FIX = join(REPO_ROOT, "scripts", "fix-of-fix.mjs");

interface Rule {
  isPatchVersion(v: string): boolean;
  sectionHeadings(changelog: string, name: string): string[] | null;
  patchAddsFeatures(v: string, headings: string[]): string | null;
}
interface FixOfFix {
  removedRanges(diff: string): { file: string; start: number; count: number }[];
  fixPairs(
    cwd: string,
    range: string,
  ): { fixes: number; pairs: { fix: { id: string }; earlier: { id: string }[] }[] };
  fixOfFixLine(cwd: string, range?: string | null): string;
}
const rule = async (): Promise<Rule> => (await import(pathToFileURL(FRAGMENTS).href)) as Rule;
const fof = async (): Promise<FixOfFix> =>
  (await import(pathToFileURL(FIX_OF_FIX).href)) as FixOfFix;

const CHANGELOG = (version: string, section: string): string =>
  [
    "## [Unreleased]",
    "",
    `## [${version}] - 2026-11-25`,
    "",
    `### ${section}`,
    "",
    "- **Entry.**",
    "",
    "## [7.2.2] - 2026-11-05",
    "",
    "### Added",
    "",
    "- **An old patch that added a feature.**",
    "",
  ].join("\n");

function release(version: string, changelog: string, fragment?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-patch-rule-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  mkdirSync(join(dir, "changes"));
  if (fragment) writeFileSync(join(dir, "changes", "f.md"), fragment);
  return dir;
}

function run(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [FRAGMENTS, ...args], { cwd: dir, encoding: "utf8" });
}

describe("patch release rule: helpers", () => {
  it("knows a patch version and reads a section's headings", async () => {
    const { isPatchVersion, sectionHeadings, patchAddsFeatures } = await rule();
    assert.deepEqual(["7.6.1", "7.6.0", "7.6.1-rc.1", "8.0.0", "1.4.10"].map(isPatchVersion), [
      true,
      false,
      false,
      false,
      true,
    ]);
    assert.deepEqual(sectionHeadings(CHANGELOG("7.6.1", "Fixed"), "7.6.1"), ["Fixed"]);
    assert.equal(sectionHeadings(CHANGELOG("7.6.1", "Fixed"), "9.9.9"), null);
    assert.match(
      patchAddsFeatures("7.6.1", ["Fixed", "Added"]) ?? "",
      /patch release is bug fixes only/,
    );
    assert.equal(patchAddsFeatures("7.7.0", ["Added"]), null);
    assert.equal(patchAddsFeatures("7.6.1", ["Fixed", "Security"]), null);
  });
});

describe("patch release rule: the publish check", () => {
  it("refuses a patch version whose section has Added, and only that version", () => {
    const bad = release("7.6.1", CHANGELOG("7.6.1", "Added"));
    const fixesOnly = release("7.6.1", CHANGELOG("7.6.1", "Fixed"));
    const minor = release("7.7.0", CHANGELOG("7.7.0", "Added"));
    try {
      const r = run(bad, "check", "--none-left");
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /7\.6\.1 is a patch release/);
      // The historical 7.2.2 section with Added is not the version being released.
      assert.equal(run(fixesOnly, "check", "--none-left").status, 0);
      assert.equal(run(minor, "check", "--none-left").status, 0);
      // Without --none-left (an ordinary fragment check) the release section is not read.
      assert.equal(run(bad, "check").status, 0);
    } finally {
      for (const d of [bad, fixesOnly, minor]) rmTemp(d);
    }
  });
});

describe("patch release rule: assemble", () => {
  it("refuses to assemble an Added fragment under a patch version and changes nothing", () => {
    const changelog = "## [Unreleased]\n\n## [7.6.0] - 2026-11-25\n\n### Added\n\n- **Old.**\n";
    const patch = release("7.6.1", changelog, "### Added\n\n- **A feature.**\n");
    const minor = release("7.7.0", changelog, "### Added\n\n- **A feature.**\n");
    try {
      const r = run(patch, "assemble");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not assembled: 7\.6\.1 is a patch release.*Bump the minor/s);
      assert.equal(readFileSync(join(patch, "CHANGELOG.md"), "utf8"), changelog);
      assert.ok(readFileSync(join(patch, "changes", "f.md"), "utf8").includes("A feature"));
      const ok = run(minor, "assemble");
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /fixes that rewrite a fix: not counted/);
    } finally {
      rmTemp(patch);
      rmTemp(minor);
    }
  });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@h.example", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function commit(cwd: string, text: string, subject: string): string {
  writeFileSync(join(cwd, "src", "a.ts"), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
}

describe("fixes that rewrite a fix", () => {
  it("reads the old-side ranges a -U0 diff removes", async () => {
    const { removedRanges } = await fof();
    const diff =
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n@@ -5,3 +5,0 @@\n@@ -9,0 +7,2 @@\n--- /dev/null\n+++ b/src/n.ts\n@@ -0,0 +1 @@\n";
    assert.deepEqual(removedRanges(diff), [
      { file: "src/a.ts", start: 2, count: 1 },
      { file: "src/a.ts", start: 5, count: 3 },
    ]);
  });

  it("names a fix that changes lines an earlier fix in the range wrote", async () => {
    const { fixPairs, fixOfFixLine } = await fof();
    const dir = mkdtempSync(join(tmpdir(), "kit-fix-of-fix-"));
    try {
      git(dir, "init", "-q");
      mkdirSync(join(dir, "src"));
      commit(dir, "one\ntwo\nthree\n", "feat: start");
      git(dir, "tag", "v1.0.0");
      commit(dir, "one\nTWO\nthree\n", "feat: a feature edits line two");
      const first = commit(dir, "ONE\nTWO\nthree\n", "fix: line one");
      commit(dir, "ONE\nTWO\nthree\nfour\n", "fix: only adds a line");
      const second = commit(dir, "One!\nTWO\nthree\nfour\n", "fix: the first fix was wrong");
      commit(dir, "One!\nTwo!\nthree\nfour\n", "fix: rewrites the feature, not a fix");
      const { fixes, pairs } = fixPairs(dir, "v1.0.0..HEAD");
      assert.equal(fixes, 4);
      assert.deepEqual(
        pairs.map((p) => [p.fix.id, p.earlier.map((c) => c.id)]),
        [[second, [first]]],
      );
      assert.match(
        fixOfFixLine(dir),
        new RegExp(
          `v1\\.0\\.0\\.\\.HEAD\\): 1 of 4 fix commits — read before tagging: ${second.slice(0, 8)} <- ${first.slice(0, 8)}`,
        ),
      );
      assert.match(fixOfFixLine(dir, "nope..HEAD"), /not counted/);
    } finally {
      rmTemp(dir);
    }
  });
});
