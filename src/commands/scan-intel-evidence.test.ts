import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it, type TestContext } from "node:test";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { makeFixture, scan, toml, tool } from "./scan.test-support.js";

const posix = {
  skip: process.platform === "win32" ? "fake scanner is a POSIX shell script" : false,
};
const cve = "CVE-2026-12345";
const kevRow = {
  cveID: "CVE-2026-12346",
  dateAdded: "2020-01-01",
  knownRansomwareCampaignUse: "Unknown",
};
const epssRow = {
  cve,
  epss: "0.25",
  percentile: "0.5",
  date: new Date().toISOString().slice(0, 10),
};

function scenario(
  t: TestContext,
  vulnerabilities: unknown[],
  data: unknown[],
  total = data.length,
) {
  const f = makeFixture();
  t.after(() => rmTemp(f.dir));
  const cache = join(f.dir, "evidence-cache.json");
  const preload = join(f.dir, "feed-fixture.mjs");
  const kev = {
    catalogVersion: "fixture",
    dateReleased: new Date().toISOString(),
    count: vulnerabilities.length,
    vulnerabilities,
  };
  const epss = {
    status: "OK",
    "status-code": 200,
    version: "1.0",
    offset: 0,
    limit: 100,
    total,
    data,
  };
  writeFileSync(
    preload,
    [
      "globalThis.fetch = async (url) => {",
      "  const target = String(url);",
      '  if (target.startsWith("https://www.cisa.gov/")) return new Response(' +
        JSON.stringify(JSON.stringify(kev)) +
        ");",
      '  if (target.startsWith("https://api.first.org/")) return new Response(' +
        JSON.stringify(JSON.stringify(epss)) +
        ");",
      '  throw new Error("Unexpected network request in the fixture");',
      "};",
    ].join("\n"),
  );
  toml(f, '[scan]\ndelegates = ["grype"]\n');
  const report = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "fixture" } },
        results: [{ ruleId: cve, level: "warning", message: { text: "Local synthetic finding" } }],
      },
    ],
  };
  tool(f, "grype", "printf '%s\\n' '" + JSON.stringify(report) + "'");
  const run = (extra: Record<string, string> = {}) =>
    scan(f, ["--strict", "--json"], {
      NODE_OPTIONS: "--import=" + pathToFileURL(preload).href,
      KIT_EXPLOIT_INTEL_CACHE: cache,
      KIT_EXPLOIT_INTEL: "1",
      KIT_AUDIT_ANCHOR: "0",
      KIT_NO_UPDATE_CHECK: "1",
      ...extra,
    });
  return { run, cache };
}

it(
  "strict scan rejects an incomplete CISA catalog and preserves its readable findings",
  posix,
  async (t) => {
    const { run } = scenario(t, [{ ...kevRow, cveID: cve }, null], [epssRow]);
    const res = await run();
    assert.equal(res.exitCode, 1, res.stdout + res.stderr);
    const verdict = JSON.parse(res.stdout);
    assert.equal(verdict.exploitIntel.kevChecked, false);
    assert.equal(verdict.exploitIntel.kevStatus, "partial");
    assert.equal(verdict.findings[0].kev.cve, cve);
    assert.equal(verdict.scannerGate.ok, false);
  },
);

it("strict scan refuses a null EPSS score", posix, async (t) => {
  const { run } = scenario(t, [kevRow], [{ ...epssRow, epss: null }]);
  const res = await run();
  assert.equal(res.exitCode, 1, res.stdout + res.stderr);
  const verdict = JSON.parse(res.stdout);
  assert.equal(verdict.exploitIntel.epssChecked, false);
  assert.equal(verdict.exploitIntel.epssStatus, "malformed");
  assert.equal(verdict.findings[0].epss, undefined);
});

it(
  "strict scan keeps a real score from an incomplete page and refuses its coverage",
  posix,
  async (t) => {
    const { run } = scenario(t, [kevRow], [epssRow], 2);
    const res = await run();
    assert.equal(res.exitCode, 1, res.stdout + res.stderr);
    const verdict = JSON.parse(res.stdout);
    assert.equal(verdict.exploitIntel.epssStatus, "partial");
    assert.equal(verdict.findings[0].epss.score, 0.25);
    assert.equal(verdict.scannerGate.ok, false);
  },
);

it(
  "strict scan accepts a complete empty EPSS result and remembers it in air gap",
  posix,
  async (t) => {
    const { run, cache } = scenario(t, [kevRow], []);
    const online = await run();
    assert.equal(online.exitCode, 0, online.stdout + online.stderr);
    assert.equal(JSON.parse(online.stdout).exploitIntel.epssStatus, "complete-empty");
    assert.equal(existsSync(cache), true);
    const offline = await run({ KIT_AIRGAP: "1" });
    assert.equal(offline.exitCode, 0, offline.stdout + offline.stderr);
    assert.equal(JSON.parse(offline.stdout).exploitIntel.epssStatus, "complete-empty");
  },
);
