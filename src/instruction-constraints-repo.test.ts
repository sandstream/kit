/**
 * Instruction constraints against a real git repository: a rule naming a file or function that a
 * change deleted, and a rule line the change dropped. kit-research shrink-anything-vs-kit: a
 * dead-code cut treats prose as non-use, so it can delete what a `CLAUDE.md` rule protects.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compareWithHead, scanConstraints } from "./instruction-constraints-repo.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const GIT = [
  "-c",
  "user.name=kit",
  "-c",
  "user.email=kit@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

function git(root: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", root, ...GIT, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

function put(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const CLAUDE = [
  "# Rules",
  "- Never remove `legacyHandler()`: partners call it.",
  "- Never edit `src/generated/schema.ts` by hand.",
  "- Never commit `config/secrets.yml`.",
  "- Never call `eval()`.",
  "- Always run `scripts/sync.sh` before a release.",
  "- Do not touch `dist/cli.js`.",
  "- Use `kit check --category security` after edits; see https://example.com/x.md.",
].join("\n");

function repo(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "kit-constraints-"));
  t.after(() => rmTemp(root));
  git(root, "init", "-q");
  put(root, {
    "CLAUDE.md": CLAUDE,
    ".gitignore": "dist/\n",
    "src/api.ts": "export function legacyHandler() {}\n",
    "src/generated/schema.ts": "export const schema = 1;\n",
    "scripts/sync.sh": "echo sync\n",
    ".claude/skills/triage/SKILL.md": "Always run `scripts/triage.py` from this directory.\n",
    ".claude/skills/triage/scripts/triage.py": "print(1)\n",
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

const listed = (root: string) =>
  scanConstraints(root).dangling.map((d) => `${d.file}:${d.line} ${d.token} ${d.evidence}`);

describe("instruction constraints: rules naming code that is gone", () => {
  it("finds nothing in a tree that has everything its rules name", (t) => {
    const root = repo(t);
    const scan = scanConstraints(root);
    assert.deepEqual(scan.dangling, []);
    assert.deepEqual(scan.incomplete, []);
    assert.equal(scan.ruleLines, 7);
  });

  it("lists a deleted protected function and file, and a missing required script", (t) => {
    const root = repo(t);
    writeFileSync(join(root, "src", "api.ts"), "export {};\n");
    git(root, "rm", "-q", "src/generated/schema.ts");
    git(root, "commit", "-q", "-m", "drop schema");
    rmSync(join(root, "scripts", "sync.sh"));
    assert.deepEqual(listed(root), [
      "CLAUDE.md:2 legacyHandler() removed",
      "CLAUDE.md:3 src/generated/schema.ts deleted",
      "CLAUDE.md:6 scripts/sync.sh deleted",
    ]);
  });

  it("does not list an obeyed prohibition, an ignored path or a never-committed bare file", (t) => {
    const root = repo(t);
    put(root, { "AGENTS.md": "Only write findings to `routes.txt`.\nNever use `NewGuid()`.\n" });
    assert.deepEqual(listed(root), []);
  });

  it("lists a missing script a rule requires inside an existing directory, without git", (t) => {
    const root = mkdtempSync(join(tmpdir(), "kit-constraints-nogit-"));
    t.after(() => rmTemp(root));
    put(root, { "AGENTS.md": "Always run `scripts/setup.sh` first.\n", "scripts/other.sh": "" });
    assert.deepEqual(listed(root), ["AGENTS.md:1 scripts/setup.sh missing"]);
  });
});

describe("instruction constraints: rule lines dropped since HEAD", () => {
  it("lists a removed and a weakened line, with HEAD's line numbers", (t) => {
    const root = repo(t);
    const now = CLAUDE.replace("- Never call `eval()`.\n", "").replace(
      "Never edit `src/generated",
      "Avoid editing `src/generated",
    );
    writeFileSync(join(root, "CLAUDE.md"), now);
    const cmp = compareWithHead(root);
    assert.deepEqual(cmp.changedFiles, ["CLAUDE.md"]);
    assert.deepEqual(
      cmp.changes.map((c) => `${c.line} ${c.kind}`),
      ["3 weakened", "5 removed"],
    );
  });

  it("says there is nothing to compare outside a git work tree", (t) => {
    const root = mkdtempSync(join(tmpdir(), "kit-constraints-nogit-"));
    t.after(() => rmTemp(root));
    assert.equal(compareWithHead(root).compared, false);
  });
});
