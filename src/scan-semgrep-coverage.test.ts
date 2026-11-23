import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ingestStrict } from "./adapters/ingest.js";
import { runSemgrepWithCoverage } from "./scan-semgrep-coverage.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const native = {
  results: [
    {
      check_id: "fixture-rule",
      path: "source.py",
      start: { line: 2 },
      extra: { severity: "ERROR", lines: "should not appear in a fallback" },
    },
  ],
  errors: [],
  paths: { scanned: ["source.py"] },
};

function sarif(line: number, score: string) {
  return JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "Semgrep OSS" } },
        results: [
          {
            ruleId: "fixture-rule",
            level: "error",
            properties: { "security-severity": score },
            message: { text: "Fixture finding" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "source.py" },
                  region: { startLine: line },
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

it("checks Semgrep files and findings against SARIF from the same process", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-semgrep-fixture-"));
  try {
    writeFileSync(join(root, "source.py"), "value = 42\nprint(value)\n");
    for (const [line, score] of [
      [2, "8"],
      [1, "8"],
      [2, "2"],
    ] as const) {
      const args = ["scan", "--json", "."];
      let report = "";
      const result = await runSemgrepWithCoverage(root, args, async (actual) => {
        assert.deepEqual(actual.slice(0, -1), [...args, "--sarif-output"]);
        report = actual.at(-1)!;
        if (process.platform !== "win32") assert.equal(statSync(report).mode & 0o777, 0o600);
        writeFileSync(report, sarif(line, score));
        return { ok: true, stdout: JSON.stringify(native) };
      });
      assert.ok(report);
      assert.equal(existsSync(report), false);
      if (line === 2 && score === "8") {
        assert.deepEqual(result.evidence, { status: "complete", fileCount: 1 });
        assert.equal(result.stdout, sarif(line, score));
      } else {
        assert.equal(result.evidence?.status, "partial");
        const parsed = ingestStrict("sarif", result.stdout);
        assert.ok(parsed.ok);
        assert.ok(
          parsed.findings.some((f) => f.severity === "high" && f.detail.includes("source.py:2")),
        );
        assert.doesNotMatch(result.stdout, /should not appear/);
      }
    }
  } finally {
    await rmTemp(root);
  }
});

it("does not accept a scanned path outside the requested project", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-semgrep-out-of-scope-"));
  try {
    const result = await runSemgrepWithCoverage(root, ["scan", "--json", "."], async (actual) => {
      writeFileSync(actual.at(-1)!, sarif(2, "8"));
      return {
        ok: true,
        stdout: JSON.stringify({ ...native, paths: { scanned: ["../source.py"] } }),
      };
    });
    assert.equal(result.evidence?.status, "partial");
    assert.match(result.stdout, /Fixture finding/);
  } finally {
    await rmTemp(root);
  }
});

it("retains a readable location-less native finding and refuses extra SARIF results", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-semgrep-extra-"));
  try {
    writeFileSync(join(root, "source.py"), "value = 42\n");
    const [original] = native.results;
    const incomplete = {
      ...original!,
      start: {},
      extra: { severity: "CRITICAL" },
    };
    for (const [results, converted] of [
      [[incomplete], ""],
      [[], sarif(2, "8").replace("source.py", "outside.py")],
    ] as const) {
      const output = await runSemgrepWithCoverage(root, ["scan", "--json", "."], async (actual) => {
        writeFileSync(actual.at(-1)!, converted);
        return { ok: true, stdout: JSON.stringify({ ...native, results }) };
      });
      assert.equal(output.evidence?.status, "partial");
      const parsed = ingestStrict("sarif", output.stdout);
      assert.ok(parsed.ok);
      assert.equal(parsed.findings.length, 1);
      if (results.length) {
        assert.equal(parsed.findings[0]?.severity, "critical");
        assert.match(parsed.findings[0]?.detail ?? "", /source\.py\)/);
      } else {
        assert.match(parsed.findings[0]?.detail ?? "", /outside\.py:2/);
      }
    }
  } finally {
    await rmTemp(root);
  }
});

it("uses the rule default severity and matches a specific column", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-semgrep-column-"));
  try {
    writeFileSync(join(root, "source.py"), "value = 42\nprint(value)\n");
    const [original] = native.results;
    const results = [{ ...original!, start: { line: 2, col: 2 } }];
    for (const column of [2, 3]) {
      const converted = JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: {
              driver: {
                name: "Semgrep OSS",
                rules: [{ id: "fixture-rule", defaultConfiguration: { level: "error" } }],
              },
            },
            results: [
              {
                ruleId: "fixture-rule",
                message: { text: "Finding with no explicit level" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "./source.py" },
                      region: { startLine: 2, startColumn: column },
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
      const output = await runSemgrepWithCoverage(root, ["scan", "--json", "."], async (actual) => {
        writeFileSync(actual.at(-1)!, converted);
        return { ok: true, stdout: JSON.stringify({ ...native, results }) };
      });
      assert.equal(output.evidence?.status, column === 2 ? "complete" : "partial");
      const parsed = ingestStrict("sarif", output.stdout);
      assert.ok(parsed.ok && parsed.findings.every(({ severity }) => severity === "high"));
    }
  } finally {
    await rmTemp(root);
  }
});
