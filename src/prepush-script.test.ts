import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Lib {
  versionMismatches(
    pkg: Record<string, Record<string, string> | undefined>,
    lock: { packages?: Record<string, { version?: string }> },
    installed: (name: string) => string | undefined,
  ): { name: string; installed: string | undefined; locked: string }[];
  testsForChanged(changed: string[], exists: (path: string) => boolean): string[];
  failedChecks(
    report: {
      stages?: { stage: string; findings?: { name: string; status: string; detail?: string }[] }[];
    },
    allow: string[],
  ): { stage: string; name: string; detail: string }[];
  parseArgs(argv: string[]): { allow: string[]; strict: boolean; skip: string[] };
  sessionUrlIn(text: string): boolean;
  COMMIT_LOG_FORMAT: string;
  commitsWithSessionUrl(log: string): string[];
  githubRepo(remoteUrl: string): { owner: string; repo: string } | undefined;
  openPrArgs(repo: { owner: string; repo: string }, branch: string): string[];
  prTextVerdict(lookup: { ok: boolean; stdout: string }): {
    ok?: boolean;
    notRun?: boolean;
    warn?: string;
    detail?: string;
  };
  parseReviewJson(text: string): { stages?: unknown[] } | undefined;
  pinnedSemgrepVersion(workflow: string): string | undefined;
  semgrepPacks(workflow: string): string[];
  semgrepVersionFrom(output: string): string | undefined;
  untestedFiles(output: string): string[];
  selfAuditErrors(output: string): string[];
}

async function lib(): Promise<Lib> {
  return (await import(pathToFileURL(join(root, "scripts", "prepush-lib.mjs")).href)) as Lib;
}

describe("versionMismatches", () => {
  const lock = {
    packages: {
      "node_modules/prettier": { version: "3.9.10" },
      "node_modules/zod": { version: "4.1.0" },
    },
  };

  it("reports a tool whose installed version differs from the lockfile", async () => {
    const { versionMismatches } = await lib();
    const got = versionMismatches(
      { devDependencies: { prettier: "3.9.10" }, dependencies: { zod: "4.1.0" } },
      lock,
      (name) => ({ prettier: "3.8.4", zod: "4.1.0" })[name],
    );
    assert.deepEqual(got, [{ name: "prettier", installed: "3.8.4", locked: "3.9.10" }]);
  });

  it("reports a declared package that is not installed", async () => {
    const { versionMismatches } = await lib();
    const got = versionMismatches({ dependencies: { zod: "4.1.0" } }, lock, () => undefined);
    assert.deepEqual(got, [{ name: "zod", installed: undefined, locked: "4.1.0" }]);
  });

  it("is quiet when everything matches, and ignores packages the lockfile does not hold", async () => {
    const { versionMismatches } = await lib();
    const got = versionMismatches(
      { devDependencies: { prettier: "3.9.10", local: "file:../x" } },
      lock,
      (name) => (name === "prettier" ? "3.9.10" : undefined),
    );
    assert.deepEqual(got, []);
  });
});

describe("testsForChanged", () => {
  const exists = (p: string) => ["dist/a.test.js", "dist/utils/b.test.js"].includes(p);

  it("maps a changed source file to its compiled test, when there is one", async () => {
    const { testsForChanged } = await lib();
    assert.deepEqual(testsForChanged(["src/a.ts", "src/utils/b.ts", "src/c.ts"], exists), [
      "dist/a.test.js",
      "dist/utils/b.test.js",
    ]);
  });

  it("runs a changed test file itself, once", async () => {
    const { testsForChanged } = await lib();
    assert.deepEqual(testsForChanged(["src/a.ts", "src/a.test.ts"], exists), ["dist/a.test.js"]);
  });

  it("ignores files outside src, and test-support files", async () => {
    const { testsForChanged } = await lib();
    assert.deepEqual(
      testsForChanged(["README.md", "scripts/x.mjs", "src/a.test-support.ts"], exists),
      [],
    );
  });
});

describe("failedChecks", () => {
  const report = {
    stages: [
      {
        stage: "check",
        findings: [
          { name: "infisical", status: "fail", detail: "session expired" },
          { name: "enforcement gate liveness", status: "fail", detail: "worktree" },
          { name: "secrets scan", status: "pass" },
        ],
      },
      { stage: "standards", findings: [{ name: "file size (scc)", status: "warn" }] },
    ],
  };

  it("lists every failing finding with its stage", async () => {
    const { failedChecks } = await lib();
    assert.deepEqual(
      failedChecks(report, []).map((f) => [f.stage, f.name]),
      [
        ["check", "infisical"],
        ["check", "enforcement gate liveness"],
      ],
    );
  });

  it("leaves out only the checks that were named as known, never by pattern", async () => {
    const { failedChecks } = await lib();
    const got = failedChecks(report, ["enforcement gate liveness"]).map((f) => f.name);
    assert.deepEqual(got, ["infisical"]);
    assert.equal(failedChecks(report, ["enforcement"]).length, 2);
  });

  it("does not count a warning as a failure", async () => {
    const { failedChecks } = await lib();
    assert.equal(
      failedChecks(report, []).some((f) => f.stage === "standards"),
      false,
    );
  });
});

describe("parseArgs and sessionUrlIn", () => {
  it("reads repeated --allow, --skip and --strict", async () => {
    const { parseArgs } = await lib();
    const got = parseArgs([
      "--allow",
      "infisical",
      "--allow",
      "x y",
      "--strict",
      "--skip",
      "tests",
    ]);
    assert.deepEqual(got, { allow: ["infisical", "x y"], strict: true, skip: ["tests"] });
  });

  it("finds a session URL in PR text", async () => {
    const { sessionUrlIn } = await lib();
    assert.equal(sessionUrlIn("see https://claude.ai/code/session_" + "01AbCd"), true);
    assert.equal(sessionUrlIn("https://claude.com/claude-code"), false);
  });
});

describe("parseReviewJson", () => {
  it("reads the report when a banner comes before it and a warning after it", async () => {
    const { parseReviewJson } = await lib();
    const text = '[kit] note\n{"ok":false,"stages":[]}\n(node) ExperimentalWarning: SQLite';
    assert.deepEqual(parseReviewJson(text), { ok: false, stages: [] });
  });

  it("returns nothing for text that holds no report", async () => {
    const { parseReviewJson } = await lib();
    assert.equal(parseReviewJson("no json here"), undefined);
    assert.equal(parseReviewJson("{ broken"), undefined);
  });
});

const WORKFLOW = `
      - run: pipx install semgrep==1.183.0
      - name: Semgrep (application code only)
        run: |
          set -e
          for config in p/security-audit p/owasp-top-ten p/typescript p/nodejs; do
            python3 scripts/run-semgrep.py --config "$config" .
          done
`;

describe("the Semgrep step follows the workflow", () => {
  it("reads the pinned version from the workflow", async () => {
    const { pinnedSemgrepVersion } = await lib();
    assert.equal(pinnedSemgrepVersion(WORKFLOW), "1.183.0");
    assert.equal(pinnedSemgrepVersion("no pin here"), undefined);
  });

  it("reads the rule packs from the loop in the workflow", async () => {
    const { semgrepPacks } = await lib();
    assert.deepEqual(semgrepPacks(WORKFLOW), [
      "p/security-audit",
      "p/owasp-top-ten",
      "p/typescript",
      "p/nodejs",
    ]);
    assert.deepEqual(semgrepPacks("nothing"), []);
  });

  it("takes the version from the last version line, after an update banner", async () => {
    const { semgrepVersionFrom } = await lib();
    const out =
      "A new version of Semgrep is available. See https://semgrep.dev/docs/upgrading\n1.167.0\n";
    assert.equal(semgrepVersionFrom(out), "1.167.0");
    assert.equal(semgrepVersionFrom("command not found"), undefined);
  });
});

describe("untestedFiles", () => {
  it("lists the files under the unit-test coverage row, ignoring colour codes", async () => {
    const { untestedFiles } = await lib();
    const out = [
      "Tests",
      "  \u001b[31m✗\u001b[0m unit-test coverage  \u001b[2m1 new untested file(s) (76 total)\u001b[0m",
      "      \u001b[2m- src/check-exposure-set.ts\u001b[0m",
      "      \u001b[2m- src/other.ts\u001b[0m",
      "no checks applied here",
    ].join("\n");
    assert.deepEqual(untestedFiles(out), ["src/check-exposure-set.ts", "src/other.ts"]);
  });

  it("returns nothing when the row passes", async () => {
    const { untestedFiles } = await lib();
    assert.deepEqual(untestedFiles("  ! unit-test coverage  75 pre-existing untested file(s)"), []);
  });
});

describe("selfAuditErrors", () => {
  it("returns the failing rules from `kit self-audit --format=github`, without the prefix", async () => {
    const { selfAuditErrors } = await lib();
    const out = [
      "::warning::self-audit/unwired-code: 118 exported functions with no production call site",
      "::error::self-audit/unreferenced-export/unreferenced exports: marksFor is exported and no other file names it [src/exploit-intel.ts:349]",
      "kit self-audit: 20 passed, 1 failed, 0 warnings, 227 advisories",
      "::error::self-audit/R1-fail-open-ci: a step swallows its failure",
    ].join("\n");
    assert.deepEqual(selfAuditErrors(out), [
      "self-audit/unreferenced-export/unreferenced exports: marksFor is exported and no other file names it [src/exploit-intel.ts:349]",
      "self-audit/R1-fail-open-ci: a step swallows its failure",
    ]);
  });

  it("returns nothing for a clean run", async () => {
    const { selfAuditErrors } = await lib();
    assert.deepEqual(selfAuditErrors("19 rules, 0 fail, 0 warn, 228 advisory\n"), []);
    assert.deepEqual(selfAuditErrors(""), []);
  });
});

describe("session URLs in commit messages and the REST PR lookup", () => {
  const SESSION = "https://claude.ai/code/session_" + "01AbCd";

  it("names the branch commits whose message holds a session URL", async () => {
    const { commitsWithSessionUrl, COMMIT_LOG_FORMAT } = await lib();
    assert.equal(COMMIT_LOG_FORMAT, "%h%x00%B%x1e");
    const log =
      "abc1234\0fix: a\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\x1e\n" +
      `def5678\0feat: b\n\nClaude-Session: ${SESSION}\n\x1e\n`;
    assert.deepEqual(commitsWithSessionUrl(log), ["def5678"]);
    assert.deepEqual(commitsWithSessionUrl(""), []);
  });

  it("reads owner/repo from https, ssh and proxy remotes, and asks REST for the branch's PRs", async () => {
    const { githubRepo, openPrArgs } = await lib();
    const want = { owner: "sandstream", repo: "kit" };
    assert.deepEqual(githubRepo("https://github.com/sandstream/kit.git\n"), want);
    assert.deepEqual(githubRepo("git@github.com:sandstream/kit.git"), want);
    assert.deepEqual(githubRepo("http://proxy@127.0.0.1:9/git/sandstream/kit"), want);
    const args = openPrArgs(want, "claude/x");
    assert.deepEqual(args.slice(0, 4), ["api", "-X", "GET", "repos/sandstream/kit/pulls"]);
    assert.ok(args.includes("head=sandstream:claude/x"));
    assert.ok(!args.some((a) => a.includes("&")), "no & for a Windows shell to split on");
  });

  it("reports a failed lookup as not run, never as a pass", async () => {
    const { prTextVerdict } = await lib();
    for (const lookup of [
      { ok: false, stdout: "" },
      { ok: true, stdout: "GraphQL: refused" },
      { ok: true, stdout: '{"message":"Not Found"}' },
    ]) {
      const v = prTextVerdict(lookup);
      assert.equal(v.notRun, true, lookup.stdout);
      assert.notEqual(v.ok, true, lookup.stdout);
    }
  });

  it("passes no PR or a clean PR, and fails a session URL in the title or body", async () => {
    const { prTextVerdict } = await lib();
    assert.equal(prTextVerdict({ ok: true, stdout: "[]" }).ok, true);
    const clean = JSON.stringify([{ title: "fix", body: "Generated with Claude Code" }]);
    assert.equal(prTextVerdict({ ok: true, stdout: clean }).ok, true);
    const dirty = JSON.stringify([{ title: "fix", body: `x\n${SESSION}` }]);
    assert.equal(prTextVerdict({ ok: true, stdout: dirty }).ok, false);
    const nullBody = JSON.stringify([{ title: `t ${SESSION}`, body: null }]);
    assert.equal(prTextVerdict({ ok: true, stdout: nullBody }).ok, false);
  });
});
