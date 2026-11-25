import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/pr-hook-evidence.mjs");

it("runs the report with both PR endpoints and full history", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /fetch-depth: .*'pull_request' && '0'/);
  assert.match(workflow, /PR_BASE: .*pull_request\.base\.sha/);
  assert.match(workflow, /PR_HEAD: .*pull_request\.head\.sha/);
  assert.match(workflow, /run: node scripts\/pr-hook-evidence\.mjs "\$PR_BASE" "\$PR_HEAD"/);
});

it(
  "reports PR commits that lack a matching hook marker",
  { skip: process.platform === "win32" },
  (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-hook-evidence-"));
    t.after(() => rmTemp(cwd));
    const terms = join(cwd, "terms");
    writeFileSync(terms, "private-fixture-text\n");
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "kit"), '#!/bin/sh\n[ "$*" = "security scan-staged" ]\n', {
      mode: 0o755,
    });
    writeFileSync(join(bin, "npm"), '#!/bin/sh\n[ "$*" = "run build" ]\n', { mode: 0o755 });
    const env = {
      ...process.env,
      INTERNAL_TERMS_FILE: terms,
      GIT_CONFIG_GLOBAL: join(cwd, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: [bin, process.env.PATH ?? ""].join(delimiter),
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    const tree = git("write-tree");
    const base = git("commit-tree", tree, "-m", "Base");
    git("update-ref", "HEAD", base);
    mkdirSync(join(cwd, ".githooks"));
    for (const [file, destination] of [
      ["pre-commit", ".git/hooks/pre-commit"],
      ["commit-msg", ".git/hooks/commit-msg"],
      ["no-internal-leaks.sh", ".githooks/no-internal-leaks.sh"],
    ]) {
      copyFileSync(join(root, ".githooks", file), join(cwd, destination));
      chmodSync(join(cwd, destination), 0o755);
    }
    assert.throws(() => git("commit", "--allow-empty", "-m", "private-fixture-text"));
    git("commit", "--allow-empty", "-m", "Ordinary change");
    const marked = git("rev-parse", "HEAD");
    assert.match(git("log", "-1", "--format=%B"), new RegExp(`Kit-Hook-Tree: ${tree}`));
    unlinkSync(join(cwd, ".git/hooks/pre-commit"));
    git("commit", "--allow-empty", "-m", "No pre-commit hook");
    const noMarker = git("rev-parse", "HEAD");
    const mismatch = git(
      "commit-tree",
      tree,
      "-p",
      noMarker,
      "-m",
      `Mismatched tree marker\n\nKit-Hook-Tree: ${"0".repeat(tree.length)}`,
    );
    const run = (head: string) =>
      spawnSync(process.execPath, [script, base, head], { cwd, encoding: "utf8" });
    const clean = run(marked);
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /markers present for 1 PR commit/);
    const partial = run(mismatch);
    assert.equal(partial.status, 0);
    assert.deepEqual(partial.stdout.trim().split(/\r?\n/), [
      "::warning title=Missing local Kit hook markers::2 of 3 PR commit(s) lack a matching hook marker.",
      mismatch,
      noMarker,
    ]);
    const unverified = run("0".repeat(tree.length));
    assert.equal(unverified.status, 0);
    assert.match(unverified.stdout, /hook markers unverified/);
  },
);
