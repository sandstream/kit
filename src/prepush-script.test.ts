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
  parseReviewJson(text: string): { stages?: unknown[] } | undefined;
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
