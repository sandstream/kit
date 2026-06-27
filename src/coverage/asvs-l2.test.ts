import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASVS_L2_SUBSET,
  ASVS_VERSION,
  ASVS_SOURCE,
  ASVS_SOURCE_URL,
} from "./asvs-l2.js";

describe("ASVS L2 vendored subset", () => {
  it("pins a concrete ASVS version and cites a source", () => {
    assert.equal(ASVS_VERSION, "4.0.3");
    assert.match(ASVS_SOURCE, /OWASP Application Security Verification Standard 4\.0\.3/);
    assert.match(ASVS_SOURCE_URL, /^https:\/\/github\.com\/OWASP\/ASVS\/tree\/v4\.0\.3$/);
  });

  it("is a non-empty, deliberately small curated subset (honest, not the full ~280)", () => {
    assert.ok(ASVS_L2_SUBSET.length > 0);
    // Honesty guard: if this ever balloons toward the full standard, the "curated
    // subset kit can speak to" claim is no longer true and this test should be
    // re-examined intentionally.
    assert.ok(
      ASVS_L2_SUBSET.length <= 40,
      `subset grew to ${ASVS_L2_SUBSET.length}; keep it curated to what kit can actually speak to`,
    );
  });

  it("has unique requirement ids", () => {
    const ids = ASVS_L2_SUBSET.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate ASVS id in subset");
  });

  it("every requirement is well-formed (id, section, text, level <= 2)", () => {
    for (const r of ASVS_L2_SUBSET) {
      assert.match(r.id, /^V\d+\.\d+\.\d+$/, `malformed ASVS id: ${r.id}`);
      assert.ok(r.section.length > 0, `empty section for ${r.id}`);
      assert.ok(r.text.length > 0, `empty text for ${r.id}`);
      assert.ok(r.level === 1 || r.level === 2, `level must be 1 or 2 for ${r.id}`);
      if (r.cwe !== undefined) {
        assert.ok(Number.isInteger(r.cwe) && r.cwe > 0, `bad cwe for ${r.id}`);
      }
    }
  });

  it("section labels are consistent across the chapter prefix", () => {
    // All controls sharing a "Vn" prefix must declare the identical section label.
    const byPrefix = new Map<string, string>();
    for (const r of ASVS_L2_SUBSET) {
      const prefix = r.id.split(".")[0]!; // e.g. "V14"
      const existing = byPrefix.get(prefix);
      if (existing) assert.equal(r.section, existing, `inconsistent section for ${prefix}`);
      else byPrefix.set(prefix, r.section);
    }
  });
});
