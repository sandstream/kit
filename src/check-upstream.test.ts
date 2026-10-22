import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { checkRunToJsonChecks, runCheckGate } from "./check-run.js";
import { upstreamRowsFromReport } from "./check-upstream.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import type { UpstreamReport, UpstreamRow } from "./upstream-report.js";

function row(over: Partial<UpstreamRow>): UpstreamRow {
  return {
    id: "convex",
    label: "Convex",
    package: "convex",
    manifest: "package.json",
    installed: "1.45.0",
    installedSource: "package-lock.json",
    range: "^1.45.0",
    latest: "1.47.0",
    bump: "minor",
    verdict: "upgrade available",
    notes: [],
    notesAvailable: false,
    ...over,
  };
}

const report = (rows: UpstreamRow[], extra: Partial<UpstreamReport> = {}): UpstreamReport => ({
  status: "ok",
  rows,
  runtimes: [],
  skippedInputs: [],
  ...extra,
});

describe("upstreamRowsFromReport", () => {
  it("passes a current package and warns on every other verdict, never fails", () => {
    const rows = upstreamRowsFromReport(
      report([
        row({ verdict: "current", installed: "1.47.0", bump: "none" }),
        row({ verdict: "upgrade available" }),
        row({ verdict: "major, read notes", bump: "major", latest: "2.0.0" }),
        row({ verdict: "upgrade recommended (deprecation)" }),
      ]),
    );
    assert.deepEqual(
      rows.map((r) => r.status),
      ["pass", "warn", "warn", "warn"],
    );
  });

  it("marks unknown and skipped as did-not-run, so a silent source is not read as current", () => {
    const rows = upstreamRowsFromReport(
      report([
        row({ verdict: "unknown", latest: null }),
        row({ verdict: "skipped", latest: null }),
      ]),
    );
    assert.deepEqual(
      rows.map((r) => [r.status, r.didNotRun]),
      [
        ["warn", true],
        ["warn", true],
      ],
    );
  });

  it("names the package, versions and verdict in the row", () => {
    const [r] = upstreamRowsFromReport(report([row({})]));
    assert.equal(r.name, "Convex: convex");
    assert.match(r.detail, /1\.45\.0 -> 1\.47\.0 \(minor\)/);
    assert.match(r.detail, /upgrade available/);
  });

  it("gives one row saying so when no cataloged service is found", () => {
    const rows = upstreamRowsFromReport(report([]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pass");
    assert.match(rows[0].detail, /no cataloged service/);
  });

  it("reports an unreadable input as a did-not-run warning", () => {
    const rows = upstreamRowsFromReport(
      report([], {
        skippedInputs: [{ path: "package-lock.json", reason: "is a symlink, not read" }],
      }),
    );
    assert.ok(rows.some((r) => r.didNotRun && /package-lock\.json/.test(r.detail)));
  });
});

describe("the upstream category is opt-in", () => {
  let dir: string;
  let originalCwd: string;
  let savedAirgap: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    savedAirgap = process.env.KIT_AIRGAP;
    dir = await mkdtemp(join(tmpdir(), "kit-check-upstream-"));
    await writeFile(join(dir, ".gitignore"), ".env\n.env.local\n.env.*.local\n.env.keys\n");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { convex: "^1.45.0" } }),
    );
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (savedAirgap === undefined) delete process.env.KIT_AIRGAP;
    else process.env.KIT_AIRGAP = savedAirgap;
    rmTemp(dir);
  });

  it("is not run by a default check and adds no rows to its JSON", async () => {
    process.env.KIT_AIRGAP = "1";
    const run = await runCheckGate({ cwd: dir, config: {} });
    assert.deepEqual(run.upstream, []);
    assert.equal(run.scope, null);
    assert.ok(checkRunToJsonChecks(run).every((c) => c.category !== "upstream"));
  });

  it("runs when selected, reports skipped in air gap, and never changes the verdict", async () => {
    process.env.KIT_AIRGAP = "1";
    const run = await runCheckGate({ cwd: dir, config: {}, categories: ["upstream"] });
    assert.deepEqual(run.scope, ["upstream"]);
    assert.equal(run.ok, true);
    assert.equal(run.upstream.length, 2, "one package row and one runtime row");
    assert.ok(run.upstream.every((u) => u.didNotRun === true));
    const json = checkRunToJsonChecks(run).filter((c) => c.category === "upstream");
    assert.equal(json.length, 2);
    assert.ok(json.every((j) => /skipped/.test(j.detail)));
  });
});
