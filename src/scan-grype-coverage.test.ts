import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { settleScanner } from "./scan-result.js";
import { readGrypeDirectoryCoverage } from "./scan-grype-coverage.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

it("accepts only a Grype inventory bound to the physical directory and its package locations", async () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "kit-grype-scope-fixture-")));
  try {
    const root = join(fixture, "target");
    mkdirSync(root);
    writeFileSync(join(root, "package-lock.json"), "{}");
    const scoped = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      metadata: {
        component: { type: "file", name: root },
        tools: { components: [{ name: "grype" }] },
      },
    };
    const entry = {
      type: "library",
      name: "pkg",
      version: "1.0.0",
      "bom-ref": "fixture",
      purl: "pkg:npm/pkg@1.0.0",
    };
    const component = (path: string) => ({
      ...entry,
      properties: [{ name: "syft:location:0:path", value: path }],
    });
    const read = (components: unknown[]) =>
      readGrypeDirectoryCoverage(JSON.stringify({ ...scoped, components }), root);
    assert.deepEqual(read([component("/package-lock.json")]), {
      status: "complete",
      packageCount: 1,
    });
    assert.equal(read([]).status, "not-applicable");
    assert.equal(read([entry]).status, "partial");
    assert.equal(read([component("/../package-lock.json")]).status, "partial");
    assert.equal(read([component(join(fixture, "outside.json"))]).status, "partial");
    assert.equal(readGrypeDirectoryCoverage(JSON.stringify(scoped), fixture).status, "partial");
    assert.equal(readGrypeDirectoryCoverage(null, root).status, "partial");
    const vulnerabilities = [
      { id: "CVE-2000-0001", affects: [{ ref: "fixture" }] },
      { id: "CVE-2000-0002", affects: [{ ref: "fixture" }] },
    ];
    const readReported = (components: unknown[]) =>
      readGrypeDirectoryCoverage(JSON.stringify({ ...scoped, components, vulnerabilities }), root);
    assert.deepEqual(readReported([component("/package-lock.json")]), {
      status: "complete",
      packageCount: 1,
      requiredFindings: [
        { name: "grype: CVE-2000-0001-pkg", version: "1.0.0" },
        { name: "grype: CVE-2000-0002-pkg", version: "1.0.0" },
      ],
    });
    assert.equal(readReported([]).status, "partial");
  } finally {
    await rmTemp(fixture);
  }
});

it("requires the declared inventory and a distinct SARIF finding for each version", () => {
  const scanner = {
    id: "grype",
    bin: "grype",
    args: [],
    format: "sarif",
    evidence: "grype-directory",
  } as const;
  const row = {
    ruleId: "example-pkg",
    message: {
      text: "A high vulnerability in npm package: pkg, version 1.0.0 was found at: /package-lock.json",
    },
  };
  const sarif = (results: unknown[]) =>
    JSON.stringify({
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "grype" } }, results }],
    });
  const settle = (rows: unknown[], evidence?: Parameters<typeof settleScanner>[1]["evidence"]) =>
    settleScanner({ ...scanner, args: [] }, { ok: true, stdout: sarif(rows), evidence });
  assert.equal(settle([row]).run.reportGap, "missing");
  const evidence = {
    status: "complete",
    packageCount: 2,
    requiredFindings: [
      { name: "grype: example-pkg", version: "1.0.0" },
      { name: "grype: example-pkg", version: "2.0.0" },
    ],
  } as const;
  const inventory = { ...evidence, requiredFindings: [...evidence.requiredFindings] };
  const partial = settle([row, row], inventory);
  assert.equal(partial.run.status, "partial");
  assert.equal(partial.findings?.length, 2);
  const second = { ...row, message: { text: row.message.text.replace("1.0.0", "2.0.0") } };
  assert.equal(settle([row, second], inventory).run.status, "ran");
});
