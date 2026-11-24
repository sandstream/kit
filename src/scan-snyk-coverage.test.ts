import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { readSnykCoverage, runSnykWithCoverage } from "./scan-snyk-coverage.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

let work: string;
let root: string;
let target: string;
const issue = "SNYK-JS-FIXTURE-1";

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "kit-snyk-test-")));
  root = join(work, "project");
  mkdirSync(root);
  target = join(root, "package-lock.json");
  writeFileSync(target, "{}");
});
afterEach(async () => rmTemp(work));

function record(count: number, ids: string[] = []) {
  return {
    path: root,
    displayTargetFile: "package-lock.json",
    dependencyCount: count,
    uniqueCount: new Set(ids).size,
    ok: ids.length === 0,
    vulnerabilities: ids.map((id) => ({ id })),
    hasUnknownVersions: false,
  };
}

function sarifRun(count: number | undefined, ids: string[] = []) {
  return {
    tool: { driver: { name: "Snyk Open Source", properties: { artifactsScanned: count } } },
    results: ids.map((ruleId) => ({ ruleId, level: "error", message: { text: "Fixture issue" } })),
  };
}

function sarif(...runs: ReturnType<typeof sarifRun>[]): string {
  return JSON.stringify({ version: "2.1.0", runs });
}

function read(input: string | null, stdout: string, root: string, exitCode = 0) {
  return readSnykCoverage(input, stdout, root, exitCode);
}

it("accepts a verified zero dependency project and multiple declared targets", () => {
  assert.deepEqual(read(JSON.stringify(record(0)), sarif(sarifRun(0)), root), {
    status: "complete",
    packageCount: 0,
    targetFiles: ["package-lock.json"],
  });
  mkdirSync(join(root, "service"));
  const peer = join(root, "service", "Gemfile");
  writeFileSync(peer, "");
  assert.deepEqual(
    read(
      JSON.stringify([
        record(1, [issue, issue]),
        { ...record(0), displayTargetFile: "service/Gemfile" },
      ]),
      sarif(sarifRun(1, [issue]), sarifRun(0)),
      root,
      1,
    ),
    {
      status: "complete",
      packageCount: 1,
      targetFiles: ["package-lock.json", relative(root, peer)],
    },
  );
});

it("distinguishes missing and malformed scope files", () => {
  const stdout = sarif(sarifRun(0));
  for (const [input, expected] of [
    [null, "missing"],
    ["{", "malformed"],
    ["null", "malformed"],
  ] as const) {
    const evidence = read(input, stdout, root);
    assert.equal(evidence.status, "partial");
    if (evidence.status === "partial") assert.equal(evidence.reportGap, expected);
  }
});

it("refuses targets outside the project, missing files and duplicate reports", () => {
  const outside = join(work, "outside.json");
  writeFileSync(outside, "{}");
  const variants = [
    { ...record(1), displayTargetFile: "../outside.json" },
    { ...record(1), displayTargetFile: outside },
    { ...record(1), displayTargetFile: "C:relative.lock" },
    { ...record(1), displayTargetFile: "missing.json" },
    { ...record(1), path: work },
  ];
  if (process.platform !== "win32") {
    const alias = join(root, "alias.json");
    symlinkSync(outside, alias);
    variants.push({ ...record(1), displayTargetFile: "alias.json" });
  }
  for (const entry of variants)
    assert.equal(read(JSON.stringify(entry), sarif(sarifRun(1)), root).status, "partial");
  assert.equal(
    read(JSON.stringify([record(1), record(1)]), sarif(sarifRun(1), sarifRun(1)), root).status,
    "partial",
  );
});

it("rejects count and issue disagreements, unknown versions and inconsistent status", () => {
  for (const details of [
    { ...record(1, [issue]), uniqueCount: 2 },
    { ...record(1, [issue]), hasUnknownVersions: true },
    { ...record(1, [issue]), ok: true },
    { ...record(1, [issue]), dependencyCount: -1 },
  ])
    assert.equal(
      read(JSON.stringify(details), sarif(sarifRun(1, [issue])), root, 1).status,
      "partial",
    );
  for (const stdout of [
    sarif(sarifRun(undefined, [issue])),
    sarif(sarifRun(0, [issue])),
    sarif(sarifRun(1, ["other"])),
    sarif(sarifRun(1)),
    sarif(sarifRun(1, [issue]), sarifRun(1)),
  ])
    assert.equal(read(JSON.stringify(record(1, [issue])), stdout, root, 1).status, "partial");
});

it("refuses a finding report with a clean exit and an empty report with a finding exit", () => {
  assert.equal(
    read(JSON.stringify(record(1, [issue])), sarif(sarifRun(1, [issue])), root, 0).status,
    "partial",
  );
  assert.equal(read(JSON.stringify(record(0)), sarif(sarifRun(0)), root, 1).status, "partial");
});

it("reads the same invocation's report and removes its temporary directory", async () => {
  let reportPath = "";
  const process = await runSnykWithCoverage(root, ["test", "--sarif"], async (args, cwd) => {
    assert.deepEqual(args.slice(0, 2), ["test", "--sarif"]);
    assert.equal(cwd, root);
    reportPath = args[2]!.slice("--json-file-output=".length);
    writeFileSync(reportPath, JSON.stringify(record(1, [issue])));
    return { ok: false, exitCode: 1, stdout: sarif(sarifRun(1, [issue])) };
  });
  assert.equal(process.evidence?.status, "complete");
  assert.equal(process.exitCode, 1);
  assert.ok(reportPath);
  assert.throws(() => realpathSync(dirname(reportPath)), { code: "ENOENT" });
});
