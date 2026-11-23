import assert from "node:assert/strict";
import { it } from "node:test";
import { rmTemp } from "../temp-cleanup.test-support.js";
import type { ScannerRun } from "../scanners.js";
import { makeFixture, scan, toml, tool } from "./scan.test-support.js";

const emptySarif = '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"Trivy"}},"results":[]}]}';
const emptyNative =
  '{"SchemaVersion":2,"ArtifactName":".","ArtifactType":"filesystem","Trivy":{"Version":"0.76.1"}}';

it(
  "refuses required Trivy coverage when the native run found nothing to scan",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const f = makeFixture();
    try {
      toml(f, '[scan]\ndelegates=["trivy"]\n[governance.scan]\nrequired_scanners=["trivy"]\n');
      tool(
        f,
        "trivy",
        `
case "$*" in
  fs*"--format json"*) printf '%s' '${emptyNative}' ;;
  *) printf '%s' '${emptySarif}' ;;
esac`,
      );
      const result = await scan(f, ["--strict", "--json"]);
      const report = JSON.parse(result.stdout) as { runs: ScannerRun[] };
      assert.equal(result.exitCode, 1, result.stdout + result.stderr);
      assert.equal(report.runs[0]?.status, "not-applicable");
    } finally {
      await rmTemp(f.dir);
    }
  },
);
