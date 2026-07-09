import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStandardReport,
  buildStandardEntries,
  formatStandardText,
  type StandardDescriptor,
} from "./standard.js";
import { OWASP_LLM_TOP10 } from "./owasp-llm-top10.js";
import { SSDF_218A } from "./ssdf-218a.js";
import type { SecurityCheckResult } from "../check-security.js";

const VALID_BUCKETS = ["auto", "gap", "manual", "na"];
const DESCRIPTORS: StandardDescriptor[] = [OWASP_LLM_TOP10, SSDF_218A];

for (const d of DESCRIPTORS) {
  describe(`standard mapping — ${d.key}`, () => {
    it("maps every requirement exactly once (no holes, no extras)", () => {
      // buildStandardEntries throws on an unmapped requirement.
      const entries = buildStandardEntries(d);
      assert.equal(entries.length, d.requirements.length);
      // every mapping key is a real requirement id
      const ids = new Set(d.requirements.map((r) => r.id));
      for (const key of Object.keys(d.mapping)) {
        assert.ok(ids.has(key), `mapping has stray id ${key}`);
      }
      assert.equal(Object.keys(d.mapping).length, d.requirements.length);
    });

    it("assigns every requirement a valid bucket", () => {
      for (const e of buildStandardEntries(d)) {
        assert.ok(VALID_BUCKETS.includes(e.bucket), `invalid bucket for ${e.requirement.id}`);
      }
    });

    it("AUTO cites ≥1 backing check; MANUAL/NA cite none", () => {
      for (const e of buildStandardEntries(d)) {
        if (e.bucket === "auto") {
          assert.ok(e.checks.length > 0, `AUTO ${e.requirement.id} must cite a check`);
        }
        if (e.bucket === "manual" || e.bucket === "na") {
          assert.equal(e.checks.length, 0, `${e.bucket} ${e.requirement.id} must not claim evidence`);
        }
      }
    });

    it("is pure + deterministic (identical across builds)", () => {
      assert.deepEqual(buildStandardReport(d), buildStandardReport(d));
    });

    it("summary tallies sum to the total", () => {
      const s = buildStandardReport(d).summary;
      assert.equal(s.auto + s.gap + s.manual + s.na, s.total);
      assert.equal(s.total, d.requirements.length);
    });

    it("disclaimer is an evidence map and NEVER claims compliant/certified", () => {
      const text = formatStandardText(buildStandardReport(d));
      assert.match(text, /evidence map, not a compliance attestation/i);
      assert.ok(!/\bcompliant\b/i.test(text), "must not claim compliant");
      assert.ok(!/\bcertified\b/i.test(text), "must not claim certified");
    });

    it("report carries key/label/version/source/disclaimer/summary/sections", () => {
      const r = buildStandardReport(d);
      assert.equal(r.key, d.key);
      assert.equal(r.label, d.label);
      assert.ok(r.version && r.source && r.sourceUrl && r.disclaimer);
      assert.ok(r.sections.length > 0);
    });
  });
}

describe("standard --verify evidence binding", () => {
  it("binds AUTO controls to live results (fail beats pass)", () => {
    // Force a couple of known backing checks to pass/fail and confirm the summary reflects it.
    const results: SecurityCheckResult[] = [
      { category: "supply-chain", name: "supply-chain", status: "pass", detail: "ok" },
      { category: "secrets", name: "secrets scan", status: "fail", detail: "leak" },
    ];
    const r = buildStandardReport(OWASP_LLM_TOP10, results);
    assert.ok(r.summary.autoVerified !== undefined, "live evidence tallied under --verify");
    // LLM02 cites "secrets scan" (failing) → should count as failing, not verified.
    const llm02 = r.sections.flatMap((s) => s.entries).find((e) => e.requirement.id === "LLM02:2025");
    assert.equal(llm02?.evidence, "failing");
  });

  it("static report (no results) carries no live evidence", () => {
    const r = buildStandardReport(SSDF_218A);
    assert.equal(r.summary.autoVerified, undefined);
    for (const e of r.sections.flatMap((s) => s.entries)) assert.equal(e.evidence, undefined);
  });
});
