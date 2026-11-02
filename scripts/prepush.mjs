#!/usr/bin/env node
// The whole local gate, run before a push. CI runs these in sequence and stops at the first red
// step, so each push used to show one failure at a time. This runs all of them and lists every
// problem at once.
//
//   node scripts/prepush.mjs [--allow "<check name>"]... [--skip <step>]... [--strict]
//
// --allow  a `kit review` check that fails for a reason outside the change (an expired login, a
//          worktree without gates). Exact name only. Printed, so it stays visible.
// --skip   one of: tools, build, format, lint, review, tests, pr-text.
// --strict a branch that is behind origin/main fails instead of warning.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  failedChecks,
  parseArgs,
  parseReviewJson,
  sessionUrlIn,
  testsForChanged,
  versionMismatches,
} from "./prepush-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const opts = parseArgs(process.argv.slice(2));
const shell = process.platform === "win32";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell });
  return {
    ok: r.status === 0,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    stdout: r.stdout ?? "",
    status: r.status,
  };
}

const tail = (text, n = 25) => text.trim().split("\n").slice(-n).join("\n");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function installedVersion(name) {
  try {
    return readJson(join(root, "node_modules", name, "package.json")).version;
  } catch {
    return undefined;
  }
}

function tools() {
  const bad = versionMismatches(readJson(join(root, "package.json")), readJson(join(root, "package-lock.json")), installedVersion);
  if (bad.length === 0) return { ok: true };
  const lines = bad.map((b) => `  ${b.name}: installed ${b.installed ?? "none"}, lockfile ${b.locked}`);
  return { ok: false, detail: `${lines.join("\n")}\n  fix: npm ci --ignore-scripts` };
}

function behind() {
  run("git", ["fetch", "origin", "main", "--quiet"]);
  const n = Number(run("git", ["rev-list", "--count", "HEAD..origin/main"]).out.trim());
  if (!(n > 0)) return { ok: true };
  const detail = `  ${n} commit(s) behind origin/main: merge main and rerun, CI tests the merge`;
  return opts.strict ? { ok: false, detail } : { ok: true, warn: detail };
}

function review() {
  const r = run(process.execPath, ["dist/cli.js", "review", "--enforce", "--json"]);
  const report = parseReviewJson(r.stdout);
  if (!report) return { ok: false, detail: `  could not read the review report\n${tail(r.out, 8)}` };
  const bad = failedChecks(report, opts.allow);
  const known = opts.allow.length > 0 ? `  allowed by you: ${opts.allow.join(", ")}\n` : "";
  if (bad.length === 0) return { ok: true, warn: known.trimEnd() || undefined };
  const lines = bad.map((f) => `  [${f.stage}] ${f.name}: ${f.detail}`.slice(0, 220));
  return { ok: false, detail: `${known}${lines.join("\n")}` };
}

function changedFiles() {
  const base = run("git", ["merge-base", "HEAD", "origin/main"]).out.trim() || "HEAD";
  const diff = run("git", ["diff", "--name-only", base]).out.split("\n");
  const fresh = run("git", ["ls-files", "--others", "--exclude-standard"]).out.split("\n");
  return [...new Set([...diff, ...fresh].map((f) => f.trim()).filter(Boolean))];
}

function tests() {
  const files = testsForChanged(changedFiles(), (p) => existsSync(join(root, p)));
  if (files.length === 0) return { ok: true, warn: "  no changed source file has a compiled test" };
  const r = run(process.execPath, ["--test", ...files]);
  return r.ok ? { ok: true, warn: `  ${files.length} test file(s)` } : { ok: false, detail: tail(r.out) };
}

function prText() {
  const r = run("gh", ["pr", "view", "--json", "title,body"]);
  if (!r.ok) return { ok: true, warn: "  no open PR for this branch, or gh is not available" };
  return sessionUrlIn(r.out)
    ? { ok: false, detail: "  the PR title or body holds a session URL: remove it (CLAUDE.md, Public artifacts)" }
    : { ok: true };
}

const npm = (script) => () => {
  const r = run("npm", ["run", script]);
  return r.ok ? { ok: true } : { ok: false, detail: tail(r.out) };
};

const steps = [
  ["tools", "installed tools match package-lock.json", tools],
  ["behind", "branch is current with origin/main", behind],
  ["build", "build", npm("build")],
  ["format", "format check", npm("format:check")],
  ["lint", "lint", npm("lint")],
  ["review", "kit review --enforce (all stages)", review],
  ["tests", "tests of the changed files", tests],
  ["pr-text", "PR text has no session URL", prText],
];

let failed = 0;
for (const [key, label, step] of steps) {
  if (opts.skip.includes(key)) {
    console.log(`- ${label} (skipped)`);
    continue;
  }
  const r = step();
  console.log(`${r.ok ? "✓" : "✗"} ${label}`);
  if (r.warn) console.log(r.warn);
  if (!r.ok) {
    failed++;
    if (r.detail) console.log(r.detail);
  }
}
console.log(failed === 0 ? "\nready to push" : `\n${failed} step(s) failed: fix them before you push`);
process.exit(failed === 0 ? 0 : 1);
