#!/usr/bin/env node
// The test-growth cap: a change that adds more than LIMIT net new test lines needs a stated reason.
// Tests are cheap to write and expensive to keep, and a branch that grows them by hundreds of lines
// usually tests the same thing many times. Over the cap the check fails, unless a commit on the
// branch carries a `Test-Growth: <reason>` trailer; then it prints the reason and passes.
//
//   node scripts/test-growth.mjs [--base <ref>] [--limit <n>]
//
// Run by scripts/prepush.mjs and by CI (.github/workflows/ci.yml). Git runs through
// execFile, with no shell.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_GROWTH_LIMIT = 400;

/** A test file or test support file under src/. */
export function isTestFile(path) {
  return /^src\/.+\.(test|test-support)\.ts$/.test(path.split("\\").join("/"));
}

/** Net added lines in test files, from `git diff --numstat` output. Binary rows ("-") count 0. */
export function netTestLines(numstat) {
  let net = 0;
  for (const line of numstat.split("\n")) {
    const [added, deleted, path] = line.split("\t");
    if (!path || !isTestFile(path.trim())) continue;
    const a = Number(added);
    const d = Number(deleted);
    if (Number.isFinite(a) && Number.isFinite(d)) net += a - d;
  }
  return net;
}

/** The reasons in `Test-Growth:` trailers of the given commit messages. */
export function growthReasons(messages) {
  const out = [];
  for (const m of messages.matchAll(/^Test-Growth:[ \t]*(\S.*)$/gim)) out.push(m[1].trim());
  return out;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Check the branch at `cwd` against `base`. Returns { ok, net, limit, reasons, message }.
 * Throws when git cannot compute the diff (no such base), so a caller cannot mistake it for a pass.
 */
export function checkTestGrowth({ cwd, base = "origin/main", limit = TEST_GROWTH_LIMIT }) {
  const net = netTestLines(git(cwd, ["diff", "--numstat", "--no-renames", `${base}...HEAD`]));
  if (net <= limit) {
    return {
      ok: true,
      net,
      limit,
      reasons: [],
      message: `${net} net new test lines (cap ${limit})`,
    };
  }
  const reasons = growthReasons(git(cwd, ["log", "--format=%B", `${base}..HEAD`]));
  if (reasons.length > 0) {
    const message = `${net} net new test lines, over the cap of ${limit}. Reason given: ${reasons.join(" | ")}`;
    return { ok: true, net, limit, reasons, message };
  }
  const message =
    `${net} net new test lines, over the cap of ${limit}. Cut duplicated tests, or state why in a ` +
    "commit message trailer: `Test-Growth: <reason>`";
  return { ok: false, net, limit, reasons, message };
}

function parseCli(argv) {
  const out = { base: "origin/main", limit: TEST_GROWTH_LIMIT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1] !== undefined) out.base = argv[++i];
    else if (argv[i] === "--limit" && argv[i + 1] !== undefined) out.limit = Number(argv[++i]);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { base, limit } = parseCli(process.argv.slice(2));
  try {
    const r = checkTestGrowth({ cwd: process.cwd(), base, limit });
    console.log(`${r.ok ? "ok" : "FAIL"}: ${r.message}`);
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    console.error(`test-growth: could not diff against ${base}: ${err.message}`);
    process.exit(2);
  }
}
