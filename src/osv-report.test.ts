import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOsvReport } from "./osv-report.js";

describe("OSV report evidence", () => {
  it("keeps valid OSV vulnerabilities and rejects invalid siblings", () => {
    const raw = JSON.stringify({
      results: [
        {
          packages: [
            {
              package: { name: "example", version: "1.0" },
              vulnerabilities: [{ id: "test-advisory" }, null],
            },
            { package: { name: "clean", version: "1.0" } },
          ],
        },
        { packages: null },
      ],
    });
    const result = readOsvReport(raw);
    assert.equal(result.gap, "partial");
    assert.equal(result.count, 1);
    assert.equal(result.packages[0].package?.name, "example");
    assert.equal(result.packages[0].vulnerabilities[0].id, "test-advisory");
  });

  it("distinguishes complete-empty OSV, missing reports and malformed data", () => {
    assert.deepEqual(readOsvReport('{"results":[]}'), { count: 0, packages: [] });
    assert.equal(readOsvReport("").gap, "missing");
    assert.equal(readOsvReport("{}").gap, "malformed");
    assert.equal(readOsvReport('{"spdxVersion":"SPDX-2.3"}').gap, "unsupported");
  });
});
