import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ASVS_L2_SUBSET } from "./asvs-l2.js";
import {
  buildCoverageEntries,
  buildCoverageReport,
  summarize,
  honestyDisclaimer,
  formatCoverageText,
  evidenceFor,
  type Bucket,
} from "./coverage.js";
import type { SecurityCheckResult } from "../check-security.js";

const VALID_BUCKETS: Bucket[] = ["auto", "gap", "manual", "na"];

/** Every distinct backing-check id across all AUTO controls, deduped. */
function autoCheckNames(): string[] {
  const names = new Set<string>();
  for (const e of buildCoverageEntries()) {
    if (e.bucket === "auto") for (const c of e.checks) names.add(c);
  }
  return [...names];
}

/** Synthesize check results (name → status) as if the scanners had run. */
function resultsFor(status: SecurityCheckResult["status"], names = autoCheckNames()) {
  return names.map(
    (name): SecurityCheckResult => ({ category: "supply-chain", name, status, detail: "fixture" }),
  );
}

describe("coverage mapping", () => {
  it("maps every ASVS subset control exactly once (no holes)", () => {
    const entries = buildCoverageEntries();
    assert.equal(entries.length, ASVS_L2_SUBSET.length);
    const mappedIds = entries.map((e) => e.requirement.id).sort();
    const subsetIds = ASVS_L2_SUBSET.map((r) => r.id).sort();
    assert.deepEqual(mappedIds, subsetIds);
  });

  it("assigns every control a valid bucket", () => {
    for (const e of buildCoverageEntries()) {
      assert.ok(VALID_BUCKETS.includes(e.bucket), `invalid bucket for ${e.requirement.id}`);
    }
  });

  it("AUTO controls cite at least one backing check; MANUAL/NA cite none", () => {
    for (const e of buildCoverageEntries()) {
      if (e.bucket === "auto") {
        assert.ok(e.checks.length > 0, `AUTO ${e.requirement.id} must list backing checks`);
      }
      if (e.bucket === "manual" || e.bucket === "na") {
        assert.equal(
          e.checks.length,
          0,
          `${e.bucket} ${e.requirement.id} must not claim deterministic evidence`,
        );
      }
    }
  });

  it("resolves catalog citations for known checks (reuses rules/catalog.ts)", () => {
    const entries = buildCoverageEntries();
    // V2.10.4 is backed by "secrets scan" -> CWE-798 in the catalog.
    const secrets = entries.find((e) => e.requirement.id === "V2.10.4")!;
    assert.ok(
      secrets.citations.some((c) => c.id === "CWE-798"),
      "V2.10.4 should carry the CWE-798 citation from the catalog",
    );
    // V10.3.2 reuses the R6-dynamic-import self-audit citation (CWE-829).
    const integrity = entries.find((e) => e.requirement.id === "V10.3.2")!;
    assert.ok(integrity.citations.length > 0, "V10.3.2 should carry catalog citations");
  });

  it("is pure + deterministic (identical across repeated builds)", () => {
    const a = JSON.stringify(buildCoverageReport());
    const b = JSON.stringify(buildCoverageReport());
    assert.equal(a, b);
  });

  it("summary tallies sum to the total", () => {
    const s = summarize(buildCoverageEntries());
    assert.equal(s.auto + s.gap + s.manual + s.na, s.total);
    assert.equal(s.total, ASVS_L2_SUBSET.length);
    // The subset is meant to demonstrate real auto coverage AND honest holes.
    assert.ok(s.auto > 0, "expected at least one AUTO control");
    assert.ok(s.gap > 0, "expected at least one honest GAP");
  });
});

describe("coverage honesty disclaimer", () => {
  it("states it is an evidence map, not a compliance attestation", () => {
    const disclaimer = honestyDisclaimer(summarize(buildCoverageEntries()));
    assert.match(disclaimer, /evidence map/i);
    assert.match(disclaimer, /not a compliance attestation/i);
    assert.match(disclaimer, /GRC/);
  });

  it("NEVER emits 'compliant' or 'certified' as a claim", () => {
    const report = buildCoverageReport();
    const haystacks = [
      report.disclaimer,
      formatCoverageText(report),
      JSON.stringify(report),
    ];
    for (const text of haystacks) {
      assert.ok(!/compliant/i.test(text), "must not claim 'compliant'");
      assert.ok(!/certified/i.test(text), "must not claim 'certified'");
    }
  });

  it("reports the auto count against the mapped total", () => {
    const s = summarize(buildCoverageEntries());
    const disclaimer = honestyDisclaimer(s);
    assert.match(disclaimer, new RegExp(`auto-verifies ${s.auto} of the ${s.total}`));
    assert.match(disclaimer, /4\.0\.3/);
  });
});

describe("coverage report shape (--json payload)", () => {
  it("carries version, source, disclaimer, summary, and grouped sections", () => {
    const report = buildCoverageReport();
    assert.equal(report.asvsVersion, "4.0.3");
    assert.match(report.sourceUrl, /OWASP\/ASVS/);
    assert.ok(report.disclaimer.length > 0);
    assert.ok(report.sections.length > 0);
    // Sections partition the entries with no loss.
    const flat = report.sections.flatMap((sec) => sec.entries);
    assert.equal(flat.length, report.summary.total);
    // Every entry exposes the fields a GRC consumer needs.
    for (const e of flat) {
      assert.ok(e.requirement.id.length > 0);
      assert.ok(VALID_BUCKETS.includes(e.bucket));
      assert.ok(typeof e.rationale === "string" && e.rationale.length > 0);
      assert.ok(Array.isArray(e.citations));
    }
  });

  it("text rendering includes the disclaimer and bucket labels", () => {
    const text = formatCoverageText(buildCoverageReport());
    assert.match(text, /Evidence map/);
    assert.match(text, /AUTO/);
    assert.match(text, /Summary:/);
  });
});

describe("coverage live evidence binding (--verify, #11)", () => {
  it("evidenceFor: fail beats pass; pass ⇒ verified; nothing ⇒ unrun", () => {
    const m = new Map<string, SecurityCheckResult["status"]>([
      ["a", "pass"],
      ["b", "fail"],
      ["c", "warn"],
    ]);
    assert.equal(evidenceFor(["a", "b"], m), "failing"); // any fail wins
    assert.equal(evidenceFor(["a"], m), "verified"); // a passing backing check
    assert.equal(evidenceFor(["c"], m), "unrun"); // ran but only warned ⇒ not verified
    assert.equal(evidenceFor(["z"], m), "unrun"); // absent ⇒ not verified
  });

  it("static report (no results) carries NO evidence and no live disclaimer line", () => {
    const report = buildCoverageReport();
    assert.equal(report.summary.autoVerified, undefined);
    for (const e of report.sections.flatMap((s) => s.entries)) {
      assert.equal(e.evidence, undefined);
    }
    assert.doesNotMatch(report.disclaimer, /This run/);
  });

  it("all-pass results bind every AUTO control to verified", () => {
    const report = buildCoverageReport(resultsFor("pass"));
    assert.equal(report.summary.autoVerified, report.summary.auto);
    assert.equal(report.summary.autoFailing, 0);
    assert.equal(report.summary.autoUnrun, 0);
    assert.match(report.disclaimer, /verified-passing/);
    assert.match(formatCoverageText(report), /Live \(--verify\)/);
  });

  it("a failing backing check flips its controls to FAILING (never silently green)", () => {
    // Fail exactly one AUTO check; every control citing it must read failing.
    const one = autoCheckNames()[0];
    const results = resultsFor("pass").map((r) =>
      r.name === one ? { ...r, status: "fail" as const } : r,
    );
    const report = buildCoverageReport(results);
    assert.ok(report.summary.autoFailing! >= 1, "the failing check must surface as failing");
    assert.equal(
      report.summary.autoVerified! + report.summary.autoFailing! + report.summary.autoUnrun!,
      report.summary.auto,
    );
    const affected = report.sections
      .flatMap((s) => s.entries)
      .filter((e) => e.bucket === "auto" && e.checks.includes(one));
    for (const e of affected) assert.equal(e.evidence, "failing");
  });

  it("unmatched checks read unrun — a mapped control is not assumed passing", () => {
    // No results at all for the AUTO checks ⇒ every AUTO control is unrun, not verified.
    const report = buildCoverageReport(resultsFor("pass", ["totally-unrelated-check"]));
    assert.equal(report.summary.autoVerified, 0);
    assert.equal(report.summary.autoUnrun, report.summary.auto);
  });

  it("binds self-audit results by ruleId, not just name (#206)", () => {
    // V7.1.1 cites "scan-transcripts" + "R2-secret-argv". A self-audit result whose
    // NAME is human-facing but whose ruleId is R2-secret-argv must bind it.
    const results: SecurityCheckResult[] = [
      {
        category: "self-audit/secret-argv",
        name: "secret leaked via exec error",
        status: "pass",
        detail: "fixture",
        ruleId: "R2-secret-argv",
      },
    ];
    const report = buildCoverageReport(results);
    const v711 = report.sections.flatMap((s) => s.entries).find((e) => e.requirement.id === "V7.1.1")!;
    assert.equal(v711.evidence, "verified");
  });

  it("resolves curated aliases (supply-chain → bumblebee) but never broad categories (#206)", () => {
    // "supply-chain" in the mapping binds to the bumblebee RESULT NAME via the
    // curated alias — an arbitrary result in the supply-chain CATEGORY must not bind.
    const bumblebee: SecurityCheckResult = {
      category: "supply-chain",
      name: "bumblebee (supply-chain)",
      status: "pass",
      detail: "fixture",
    };
    const v1424 = (r: ReturnType<typeof buildCoverageReport>) =>
      r.sections.flatMap((s) => s.entries).find((e) => e.requirement.id === "V14.2.4")!;
    assert.equal(v1424(buildCoverageReport([bumblebee])).evidence, "verified");
    // Same category, different name, no alias ⇒ must NOT verify (no category matching).
    const unrelated: SecurityCheckResult = {
      category: "supply-chain",
      name: "pinned versions",
      status: "pass",
      detail: "fixture",
    };
    assert.equal(v1424(buildCoverageReport([unrelated])).evidence, "unrun");
  });
});
