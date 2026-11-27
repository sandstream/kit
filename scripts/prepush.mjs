#!/usr/bin/env node
// The whole local gate, run before a push. CI runs these in sequence and stops at the first red
// step, so each push used to show one failure at a time. This runs all of them and lists every
// problem at once.
//
//   node scripts/prepush.mjs [--allow "<check name>"]... [--skip <step>]... [--strict]
//
// --allow  a `kit review` check that fails for a reason outside the change (an expired login, a
//          worktree without gates). Exact name only. Printed, so it stays visible.
// --skip   one of: tools, build, format, lint, review, tests, coverage, test-growth, semgrep,
//          self-audit, commit-text, pr-text.
// --strict a branch that is behind origin/main, or a Semgrep that is not the CI version, fails
//          instead of warning.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  COMMIT_LOG_FORMAT,
  commitsWithSessionUrl,
  failedChecks,
  githubRepo,
  openPrArgs,
  parseArgs,
  parseReviewJson,
  pinnedSemgrepVersion,
  semgrepPacks,
  selfAuditErrors,
  semgrepVersionFrom,
  prTextVerdict,
  testsForChanged,
  untestedFiles,
  versionMismatches,
} from "./prepush-lib.mjs";
import { checkTestGrowth } from "./test-growth.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const opts = parseArgs(process.argv.slice(2));
const shell = process.platform === "win32";

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell,
  });
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
  const bad = versionMismatches(
    readJson(join(root, "package.json")),
    readJson(join(root, "package-lock.json")),
    installedVersion,
  );
  if (bad.length === 0) return { ok: true };
  const lines = bad.map(
    (b) => `  ${b.name}: installed ${b.installed ?? "none"}, lockfile ${b.locked}`,
  );
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
  if (!report)
    return { ok: false, detail: `  could not read the review report\n${tail(r.out, 8)}` };
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
  // As scripts/test.mjs does: no real `mise` a test reaches may read this machine's global mise
  // config, where an npm: tool at "latest" made mise recurse through its own npm shim.
  const saved = process.env.MISE_GLOBAL_CONFIG_FILE;
  process.env.MISE_GLOBAL_CONFIG_FILE = join(tmpdir(), "kit-test-no-global-mise-config.toml");
  let r;
  try {
    r = run(process.execPath, ["--test", ...files]);
  } finally {
    if (saved === undefined) delete process.env.MISE_GLOBAL_CONFIG_FILE;
    else process.env.MISE_GLOBAL_CONFIG_FILE = saved;
  }
  return r.ok
    ? { ok: true, warn: `  ${files.length} test file(s)` }
    : { ok: false, detail: tail(r.out) };
}

// CI's "Test-coverage gate": a new source file with no test fails. `kit review` does not run it.
function coverage() {
  const r = run(process.execPath, [
    "dist/cli.js",
    "check",
    "--category",
    "tests",
    "--enforce-tests",
  ]);
  if (r.ok) return { ok: true };
  const files = untestedFiles(r.out);
  const detail =
    files.length > 0 ? files.map((f) => `  untested: ${f}`).join("\n") : tail(r.out, 12);
  return { ok: false, detail };
}

// CI's test-growth cap (.github/workflows/pr-hygiene.yml): over 400 net new test lines needs a
// `Test-Growth: <reason>` commit trailer.
function testGrowth() {
  try {
    const r = checkTestGrowth({ cwd: root });
    return r.ok ? { ok: true, warn: `  ${r.message}` } : { ok: false, detail: `  ${r.message}` };
  } catch (err) {
    return { ok: false, detail: `  could not diff against origin/main: ${err.message}` };
  }
}

// CI's Semgrep scan, with the version and the rule packs the workflow names. Another Semgrep version
// parses source differently (a variable named `using` parsed locally and failed in CI), so a
// different version is not a substitute: it skips with a warning, and --strict makes it a failure.
function semgrep() {
  const workflow = readFileSync(join(root, ".github", "workflows", "security.yml"), "utf8");
  const pinned = pinnedSemgrepVersion(workflow);
  const packs = semgrepPacks(workflow);
  if (!pinned || packs.length === 0) {
    return {
      ok: false,
      detail: "  could not read the Semgrep version and packs from .github/workflows/security.yml",
    };
  }
  const have = semgrepVersionFrom(run("semgrep", ["--version"]).out);
  if (have !== pinned) {
    const detail = `  semgrep ${have ?? "not found"}, CI uses ${pinned}: not run. Install ${pinned} in a virtual environment and put it on PATH`;
    return opts.strict ? { ok: false, detail } : { ok: true, notRun: true, warn: detail };
  }
  const python = process.platform === "win32" ? "python" : "python3";
  for (const pack of packs) {
    const r = run(python, ["scripts/run-semgrep.py", "--config", pack, "."]);
    if (!r.ok) return { ok: false, detail: `  pack ${pack}\n${tail(r.out, 12)}` };
  }
  return { ok: true, warn: `  semgrep ${have}, ${packs.length} packs` };
}

// CI's "kit self-audit" job. It fails on rules `kit review` does not run, such as an export that no
// other file names, and it stopped two pull requests that `kit review` had passed.
function selfAudit() {
  const r = run(process.execPath, ["dist/cli.js", "self-audit", "--format=github"]);
  if (r.ok) return { ok: true };
  const errors = selfAuditErrors(r.out);
  const detail = errors.length > 0 ? errors.map((e) => `  ${e}`).join("\n") : tail(r.out, 12);
  return { ok: false, detail };
}

// git without a shell: on Windows `cmd` would read the `%h%` in a log format as a variable.
function git(args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? "" };
}

// The branch's own commits, origin/main..HEAD. Commits already on main stay as they are.
function commitText() {
  const r = git(["log", `--format=${COMMIT_LOG_FORMAT}`, "origin/main..HEAD"]);
  if (!r.ok) {
    const warn = "  could not list origin/main..HEAD: the commit messages were not checked";
    return { ok: !opts.strict, notRun: true, warn };
  }
  const hits = commitsWithSessionUrl(r.stdout);
  if (hits.length === 0) return { ok: true };
  return {
    ok: false,
    detail: `  commit(s) ${hits.join(", ")} hold a session URL in the message: reword them before you push (CLAUDE.md, Public artifacts)`,
  };
}

// REST, not `gh pr view`: GraphQL is refused in agent sessions, and that refusal used to read as
// "no open PR" and pass.
function prText() {
  const repo = githubRepo(git(["remote", "get-url", "origin"]).stdout);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const lookup =
    repo && branch && branch !== "HEAD"
      ? run("gh", openPrArgs(repo, branch))
      : { ok: false, stdout: "" };
  const verdict = prTextVerdict({ ok: lookup.ok, stdout: lookup.stdout });
  return verdict.notRun ? { ...verdict, ok: !opts.strict } : verdict;
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
  ["coverage", "every new source file has a test (CI coverage gate)", coverage],
  ["test-growth", "net new test lines within the cap, or a stated reason", testGrowth],
  ["self-audit", "kit self-audit (CI's self-audit job)", selfAudit],
  ["semgrep", "Semgrep at the CI version and packs", semgrep],
  ["commit-text", "commit messages on the branch have no session URL", commitText],
  ["pr-text", "PR text has no session URL", prText],
];

let failed = 0;
let notRun = 0;
for (const [key, label, step] of steps) {
  if (opts.skip.includes(key)) {
    console.log(`- ${label} (skipped)`);
    continue;
  }
  const r = step();
  // A step that could not run is not a pass: it shows "!" and is counted in the summary.
  console.log(`${r.notRun ? "!" : r.ok ? "✓" : "✗"} ${label}`);
  if (r.notRun) notRun++;
  if (r.warn) console.log(r.warn);
  if (!r.ok) {
    failed++;
    if (r.detail) console.log(r.detail);
  }
}
const unrun = notRun > 0 ? ` (${notRun} step(s) did not run: see the lines marked !)` : "";
console.log(
  failed === 0
    ? `\nready to push${unrun}`
    : `\n${failed} step(s) failed: fix them before you push${unrun}`,
);
process.exit(failed === 0 ? 0 : 1);
