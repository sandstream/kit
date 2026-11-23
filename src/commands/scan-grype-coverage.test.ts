import assert from "node:assert/strict";
import { it } from "node:test";
import type { ScannerRun } from "../scanners.js";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { EMPTY_SARIF, makeFixture, scan, toml, tool } from "./scan.test-support.js";

const requirement =
  '[scan]\ndelegates = ["grype"]\n[governance.scan]\nrequired_scanners = ["grype"]\n';

it(
  "uses the physical Grype scope and refuses an empty package inventory",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const f = makeFixture();
    try {
      toml(f, requirement);
      tool(
        f,
        "grype",
        `
      [ "$1" = "dir:$PWD" ] || exit 4
      for arg in "$@"; do
        case "$arg" in
          cyclonedx-json=*) printf '{"bomFormat":"CycloneDX","specVersion":"1.6","metadata":{"component":{"name":"%s","type":"file"},"tools":{"components":[{"name":"grype"}]}}}' "$PWD" > "\${arg#*=}" ;;
        esac
      done
      printf '%s' '${EMPTY_SARIF}'
    `,
        false,
      );
      const result = await scan(f, ["--strict", "--json"]);
      const summary = JSON.parse(result.stdout) as { runs: ScannerRun[] };
      assert.equal(result.exitCode, 1);
      assert.deepEqual(
        summary.runs.map(({ id, status, noTarget }) => ({ id, status, noTarget })),
        [{ id: "grype", status: "not-applicable", noTarget: true }],
      );
    } finally {
      await rmTemp(f.dir);
    }
  },
);

it(
  "retains Grype findings when its inventory is missing",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const f = makeFixture();
    try {
      toml(f, requirement);
      const sarif = JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "grype" } },
            results: [
              { ruleId: "example", level: "warning", message: { text: "Synthetic finding" } },
            ],
          },
        ],
      });
      tool(f, "grype", "printf '%s' '" + sarif + "'", false);
      const result = await scan(f, ["--strict", "--json"], { KIT_EXPLOIT_INTEL: "0" });
      const summary = JSON.parse(result.stdout) as { runs: ScannerRun[]; findings: unknown[] };
      assert.equal(result.exitCode, 1, result.stdout + result.stderr);
      assert.equal(summary.runs[0]?.status, "partial");
      assert.equal(summary.runs[0]?.reportGap, "missing");
      assert.equal(summary.findings.length, 1);
    } finally {
      await rmTemp(f.dir);
    }
  },
);
