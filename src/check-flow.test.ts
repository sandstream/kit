/**
 * Characterization of the `kit check` run (the governed callback in src/commands/check.ts)
 * before it is split. It spawns the built CLI in a disposable repo with a disposable HOME,
 * so the update cache and the memory store never touch the developer's own.
 * Every test must pass on the unsplit callback and on the split one.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli, type CliResult } from "./cli-run.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string): string => s.replace(ANSI, "");

interface Repo {
  root: string;
  home: string;
}

function makeRepo(toml: string): Repo {
  const root = mkdtempSync(join(tmpdir(), "kit-chkflow-"));
  const home = join(root, "home");
  mkdirSync(home);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, ".gitignore"), ".env\n.env.local\n.env.*.local\n");
  writeFileSync(join(repo, ".kit.toml"), toml);
  return { root: repo, home };
}

function dropRepo(r: Repo): void {
  rmTemp(join(r.root, ".."));
}

/** Runs `kit check` with the update check off, hints off and a CI-free environment. */
function check(r: Repo, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return runCli(["check", ...args], r.root, {
    HOME: r.home,
    USERPROFILE: r.home,
    KIT_NO_UPDATE_CHECK: "1",
    KIT_NO_HINTS: "1",
    CI: "",
    GITHUB_ACTIONS: "",
    GITLAB_CI: "",
    ...env,
  });
}

describe("kit check: refusals before the run", () => {
  let r: Repo;
  before(() => {
    r = makeRepo("");
  });
  after(() => dropRepo(r));

  it("an unknown subcommand is refused with the usage line", async () => {
    const res = await check(r, ["zzz"]);
    assert.equal(res.exitCode, 1);
    assert.match(plain(res.stderr), /Unknown check subcommand: zzz/);
    assert.match(plain(res.stderr), /Usage: kit check/);
  });

  it("an unknown flag is refused and the accepted flags are listed", async () => {
    const res = await check(r, ["--bogus"]);
    assert.equal(res.exitCode, 1);
    assert.match(plain(res.stderr), /unknown flag for kit check: --bogus/);
    assert.match(plain(res.stderr), /accepted: --attest --category /);
  });

  it("an unknown category is refused and the categories are listed", async () => {
    const res = await check(r, ["--category", "nonsense"]);
    assert.equal(res.exitCode, 1);
    assert.match(plain(res.stderr), /unknown --category value: nonsense/);
    assert.match(plain(res.stderr), /accepted: tools services secrets/);
  });
});

describe("kit check: text output", () => {
  let r: Repo;
  before(() => {
    r = makeRepo('[hooks]\npre-commit = ["echo hi"]\n');
  });
  after(() => dropRepo(r));

  it("prints the header, the hook table, the scope line and the partial-run line", async () => {
    const res = await check(r, ["--category", "hooks"]);
    const out = plain(res.stdout);
    assert.match(out, /Checks\n─+/);
    assert.match(out, /Git Hooks\n {2}✗ pre-commit {2}not installed/);
    assert.match(out, /scope: 1 check\(s\) — 1 inspect the code, none execute the code\./);
    assert.match(out, /partial run — only hooks ran; this verdict does NOT cover the other/);
    assert.ok(out.indexOf("Git Hooks") < out.indexOf("scope: 1 check(s)"));
    assert.ok(out.indexOf("scope: 1 check(s)") < out.indexOf("partial run"));
  });

  it("prints the test-coverage section with its detail line", async () => {
    const res = await check(r, ["--category", "tests"]);
    const out = plain(res.stdout);
    assert.match(out, /Tests\n {2}- unit-test coverage {2}no source directories matched/);
    assert.match(out, /1 executes it/);
    assert.match(out, /partial run — only tests ran/);
  });

  it("a hooks-only run prints no test section", async () => {
    const res = await check(r, ["--category", "hooks"]);
    assert.equal(plain(res.stdout).includes("\nTests\n"), false);
  });

  it("a run with no applicable check says so and exits 0", async () => {
    const res = await check(r, ["--category", "secrets"]);
    assert.equal(res.exitCode, 0);
    assert.match(plain(res.stdout), /no checks applied here/);
  });
});

describe("kit check: --json output", () => {
  let r: Repo;
  before(() => {
    r = makeRepo('[hooks]\npre-commit = ["echo hi"]\n');
  });
  after(() => dropRepo(r));

  it("prints one JSON document and no human text", async () => {
    const res = await check(r, ["--category", "tests", "--json"]);
    const doc = JSON.parse(res.stdout) as {
      ok: boolean;
      checks: Array<{ category: string; status: string }>;
      summary: Record<string, number>;
      scope?: string[];
    };
    assert.equal(doc.ok, true);
    assert.deepEqual(doc.scope, ["tests"]);
    assert.deepEqual(Object.keys(doc.summary), ["passed", "failed", "warnings", "skipped"]);
    const total = Object.values(doc.summary).reduce((a, b) => a + b, 0);
    assert.equal(total, doc.checks.length);
    assert.equal(plain(res.stdout).includes("Checks\n"), false);
  });

  it("counts a check of each status in the summary", async () => {
    const res = await check(r, ["--category", "hooks,tests", "--json"]);
    const doc = JSON.parse(res.stdout) as {
      checks: Array<{ status: string }>;
      summary: { passed: number; failed: number; warnings: number; skipped: number };
    };
    const count = (s: string) => doc.checks.filter((c) => c.status === s).length;
    assert.equal(doc.summary.passed, count("pass"));
    assert.equal(doc.summary.failed, count("fail"));
    assert.equal(doc.summary.warnings, count("warn"));
    assert.equal(
      doc.summary.skipped,
      doc.checks.length - count("pass") - count("fail") - count("warn"),
    );
  });

  it("a full run has no scope key", async () => {
    const res = await check(r, ["--json"]);
    const doc = JSON.parse(res.stdout) as Record<string, unknown>;
    assert.equal("scope" in doc, false);
    assert.equal(typeof doc.ok, "boolean");
  });
});

describe("kit check: attestation and update notice", () => {
  let r: Repo;
  before(() => {
    r = makeRepo("");
  });
  after(() => dropRepo(r));

  it("writes no attestation unless asked", async () => {
    await check(r, ["--category", "tests"]);
    assert.equal(existsSync(join(r.root, ".kit-check-attestation.json")), false);
  });

  it("--attest in text mode writes the receipt and names it", async () => {
    const res = await check(r, ["--category", "tests", "--attest"]);
    assert.match(plain(res.stdout), /attestation: .*\.kit-check-attestation\.json/);
    assert.equal(existsSync(join(r.root, ".kit-check-attestation.json")), true);
  });

  it("--attest with --json keeps stdout a single JSON document", async () => {
    const res = await check(r, ["--category", "tests", "--attest", "--json"]);
    assert.doesNotThrow(() => JSON.parse(res.stdout));
  });

  it("a cached newer version prints the update notice after the verdict", async () => {
    mkdirSync(join(r.home, ".kit"), { recursive: true });
    writeFileSync(
      join(r.home, ".kit", "last-update-check.json"),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: "99.0.0" }),
    );
    const res = await check(r, ["--category", "tests"], { KIT_NO_UPDATE_CHECK: "" });
    const out = plain(res.stdout);
    assert.match(out, /! kit \d+\.\d+\.\d+ → 99\.0\.0 available — run kit upgrade --self/);
    assert.ok(out.indexOf("partial run") < out.indexOf("99.0.0"));
  });

  it("[update] check = false suppresses the notice", async () => {
    writeFileSync(join(r.root, ".kit.toml"), "[update]\ncheck = false\n");
    const res = await check(r, ["--category", "tests"], { KIT_NO_UPDATE_CHECK: "" });
    // The banner cli.ts prints after any command is a separate path; this pins the check's own line.
    assert.doesNotMatch(plain(res.stdout), /! kit \S+ → 99\.0\.0 available/);
  });

  it("KIT_NO_UPDATE_CHECK=1 suppresses the notice", async () => {
    writeFileSync(join(r.root, ".kit.toml"), "");
    const res = await check(r, ["--category", "tests"]);
    assert.doesNotMatch(plain(res.stdout), /99\.0\.0/);
  });
});
