import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lockComponents, toCycloneDX, toSpdx, toSarif } from "./sbom.js";
import type { LockPkg } from "./supply-chain.js";
import type { SecurityCheckResult } from "./check-security.js";

const lockPkgs: LockPkg[] = [
  { path: "node_modules/lodash", name: "lodash", version: "4.17.21" },
  { path: "node_modules/lodash", name: "lodash", version: "4.17.21" }, // dup
  { path: "node_modules/zod", name: "zod", version: "3.23.0" },
  { path: "node_modules/x", name: "x" }, // no version → skipped
];

describe("lockComponents", () => {
  it("dedupes, drops versionless, sorts by name", () => {
    const comps = lockComponents(lockPkgs);
    assert.deepEqual(comps, [
      { name: "lodash", version: "4.17.21" },
      { name: "zod", version: "3.23.0" },
    ]);
  });
});

describe("toCycloneDX", () => {
  it("emits CycloneDX with purls", () => {
    const bom = toCycloneDX(lockComponents(lockPkgs)) as {
      bomFormat: string;
      components: { purl: string }[];
    };
    assert.equal(bom.bomFormat, "CycloneDX");
    assert.equal(bom.components.length, 2);
    assert.equal(bom.components[0].purl, "pkg:npm/lodash@4.17.21");
  });
});

describe("toSpdx", () => {
  it("emits SPDX packages with purl externalRefs", () => {
    const doc = toSpdx(lockComponents(lockPkgs)) as {
      spdxVersion: string;
      packages: { versionInfo: string; externalRefs: { referenceLocator: string }[] }[];
    };
    assert.equal(doc.spdxVersion, "SPDX-2.3");
    assert.equal(doc.packages.length, 2);
    assert.equal(doc.packages[0].externalRefs[0].referenceLocator, "pkg:npm/lodash@4.17.21");
  });
});

describe("toSarif", () => {
  const findings: SecurityCheckResult[] = [
    {
      category: "dependency",
      name: "lodash CVE-x",
      status: "fail",
      detail: "proto pollution",
      severity: "high",
      rule: {
        id: "OWASP-A06",
        source: "owasp",
        ref: "https://owasp.org/x",
        title: "Vuln Components",
      },
    },
    { category: "exposure", name: "minor", status: "warn", detail: "meh", severity: "low" },
  ];
  it("maps findings to SARIF results + rules with severity/level", () => {
    const sarif = toSarif(findings) as {
      version: string;
      runs: {
        tool: { driver: { name: string; rules: unknown[] } };
        results: { ruleId: string; level: string }[];
      }[];
    };
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs[0].tool.driver.name, "kit");
    assert.equal(sarif.runs[0].results.length, 2);
    assert.equal(sarif.runs[0].results[0].level, "error"); // high → error
    assert.equal(sarif.runs[0].results[1].level, "note"); // low → note
    assert.equal(sarif.runs[0].tool.driver.rules.length, 2);
  });
});
