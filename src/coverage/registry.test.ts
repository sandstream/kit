import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COVERAGE_STANDARDS,
  COVERAGE_STANDARD_KEYS,
  getCoverageStandard,
  enabledCoverageStandards,
  isCoverageStandardEnabled,
} from "./registry.js";

describe("coverage standards registry", () => {
  it("registers the expected standards, asvs first (the default)", () => {
    assert.deepEqual(
      [...COVERAGE_STANDARD_KEYS],
      ["asvs", "llm-top10", "ssdf", "agentic-top10", "mcp-top10", "aiuc-1", "gcp-waf-security"],
    );
    assert.equal(COVERAGE_STANDARDS[0]?.key, "asvs");
  });

  it("asvs is the legacy kind (no descriptor); the rest carry a descriptor", () => {
    for (const s of COVERAGE_STANDARDS) {
      if (s.key === "asvs") {
        assert.equal(s.kind, "asvs");
        assert.equal(s.descriptor, undefined);
      } else {
        assert.equal(s.kind, "descriptor");
        assert.ok(s.descriptor, `${s.key} must carry a descriptor`);
        assert.equal(s.descriptor?.key, s.key, "registry key matches descriptor key");
      }
      assert.ok(s.label && s.version, `${s.key} has label + version`);
    }
  });

  it("the two new agent-native standards each map exactly 10 controls", () => {
    for (const key of ["agentic-top10", "mcp-top10"]) {
      const d = getCoverageStandard(key)?.descriptor;
      assert.ok(d, `${key} present`);
      assert.equal(d?.requirements.length, 10, `${key} has 10 requirements`);
      assert.equal(
        Object.keys(d?.mapping ?? {}).length,
        10,
        `${key} maps all 10`,
      );
    }
  });

  it("getCoverageStandard resolves known keys and rejects unknown", () => {
    assert.equal(getCoverageStandard("mcp-top10")?.key, "mcp-top10");
    assert.equal(getCoverageStandard("nope"), undefined);
  });

  it("no toggle ⇒ everything enabled (backwards-compatible)", () => {
    assert.equal(enabledCoverageStandards().length, COVERAGE_STANDARDS.length);
    assert.equal(enabledCoverageStandards([]).length, COVERAGE_STANDARDS.length);
    assert.equal(isCoverageStandardEnabled("agentic-top10"), true);
    assert.equal(isCoverageStandardEnabled("agentic-top10", []), true);
  });

  it("allow-list toggles standards on/off, in registry order", () => {
    const enabled = enabledCoverageStandards(["mcp-top10", "asvs"]);
    assert.deepEqual(
      enabled.map((s) => s.key),
      ["asvs", "mcp-top10"], // registry order, not config order
    );
    assert.equal(isCoverageStandardEnabled("asvs", ["mcp-top10", "asvs"]), true);
    assert.equal(isCoverageStandardEnabled("llm-top10", ["mcp-top10", "asvs"]), false);
  });
});
