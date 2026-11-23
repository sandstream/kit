import assert from "node:assert/strict";
import { it } from "node:test";
import { rmTemp } from "../temp-cleanup.test-support.js";
import type { ScannerRun } from "../scanners.js";
import { makeFixture, scan, toml, tool } from "./scan.test-support.js";

const emptySarif =
  '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"Semgrep"}},"results":[]}]}';
const emptyNative = '{"version":"1.183.0","results":[],"errors":[],"paths":{"scanned":[]}}';

it(
  "refuses a required Semgrep run with no scanned files",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = makeFixture();
    try {
      toml(
        fixture,
        '[scan]\ndelegates=["semgrep"]\n[governance.scan]\nrequired_scanners=["semgrep"]\n',
      );
      tool(
        fixture,
        "semgrep",
        `
report=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --sarif-output ]; then shift; report="$1"; fi
  shift
done
if [ -n "$report" ]; then
  printf '%s' '${emptySarif}' > "$report"
  printf '%s' '${emptyNative}'
else
  printf '%s' '${emptySarif}'
fi`,
      );
      const result = await scan(fixture, ["--strict", "--json"], {
        KIT_SEMGREP_CONFIG: "./rules.yml",
      });
      const report = JSON.parse(result.stdout) as { runs: ScannerRun[] };
      assert.equal(result.exitCode, 1, result.stdout + result.stderr);
      assert.equal(report.runs[0]?.status, "not-applicable");
    } finally {
      await rmTemp(fixture.dir);
    }
  },
);
