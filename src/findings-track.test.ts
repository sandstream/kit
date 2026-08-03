import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { actionableFindings, securityFindingToSync, advisoryFindings } from "./findings-track.js";
import type { SecurityCheckResult } from "./check-security.js";

// The bridge from a security finding to a PAL ledger row. The pure half had no tests,
// and two properties here are load-bearing: WHICH findings reach the ledger (too many and
// `kit heal` is noise, too few and a real finding is never tracked), and whether
// `dedupKey` is stable across re-scans — an unstable key means the same finding
// reappears as a new row forever and auto-close never fires.

function result(over: Partial<SecurityCheckResult>): SecurityCheckResult {
  return { category: "dependency", name: "check", status: "pass", detail: "", ...over };
}

describe("actionableFindings", () => {
  it("tracks every fail regardless of category", () => {
    const rows = [
      result({ status: "fail", category: "dependency", name: "npm audit" }),
      result({ status: "fail", category: "self-audit/docs-claims", name: "documented commands" }),
    ];
    assert.equal(actionableFindings(rows).length, 2);
  });

  it("tracks a warn only in the security-relevant categories", () => {
    const tracked = ["secrets", "exposure", "supply-chain"] as const;
    for (const category of tracked) {
      assert.equal(
        actionableFindings([result({ status: "warn", category })]).length,
        1,
        `${category} warn must be tracked`,
      );
    }
  });

  it("drops a warn in a category that would only add noise", () => {
    // `dependency` warns (a scanner absent, a container CVE unchecked) recur on every
    // run of every machine; tracking them buries the findings that need action.
    assert.deepEqual(actionableFindings([result({ status: "warn", category: "dependency" })]), []);
    assert.deepEqual(
      actionableFindings([result({ status: "warn", category: "self-audit/unwired-code" })]),
      [],
    );
  });

  it("never tracks a pass or a skip", () => {
    const rows = [
      result({ status: "pass", category: "secrets" }),
      result({ status: "skip", category: "secrets" }),
    ];
    assert.deepEqual(actionableFindings(rows), []);
  });

  it("returns an empty array for no input rather than throwing", () => {
    assert.deepEqual(actionableFindings([]), []);
  });

  it("preserves input order", () => {
    const rows = [
      result({ status: "fail", name: "first" }),
      result({ status: "warn", category: "secrets", name: "second" }),
      result({ status: "fail", name: "third" }),
    ];
    assert.deepEqual(
      actionableFindings(rows).map((r) => r.name),
      ["first", "second", "third"],
    );
  });
});

describe("securityFindingToSync", () => {
  it("keys on category + name so a re-scan maps to the same ledger row", () => {
    const r = result({ category: "secrets", name: "secrets scan", status: "fail" });
    assert.equal(securityFindingToSync(r).dedupKey, "secrets:secrets scan");
  });

  it("excludes volatile values from the key — the same finding must not fork a new row", () => {
    // detail carries counts, paths and timestamps that change between runs. If any of
    // that reached the key, every re-scan would open a duplicate and auto-close would
    // never match an existing row.
    const a = securityFindingToSync(
      result({ category: "secrets", name: "scan", status: "fail", detail: "3 findings in a.ts" }),
    );
    const b = securityFindingToSync(
      result({ category: "secrets", name: "scan", status: "fail", detail: "9 findings in b.ts" }),
    );
    assert.equal(a.dedupKey, b.dedupKey);
  });

  it("puts the status in the title, so a warn and a fail read differently", () => {
    assert.equal(
      securityFindingToSync(result({ name: "npm audit", status: "fail" })).title,
      "npm audit: fail",
    );
    assert.equal(
      securityFindingToSync(result({ name: "npm audit", status: "warn" })).title,
      "npm audit: warn",
    );
  });

  it("appends the suggestion to the detail so the row is actionable on its own", () => {
    const s = securityFindingToSync(
      result({ detail: "2 high advisories", suggestion: "run npm audit fix" }),
    );
    assert.equal(s.detail, "2 high advisories · Fix: run npm audit fix");
  });

  it("uses the detail alone when there is no suggestion", () => {
    assert.equal(
      securityFindingToSync(result({ detail: "2 high advisories" })).detail,
      "2 high advisories",
    );
  });

  it("uses the suggestion alone when there is no detail", () => {
    assert.equal(
      securityFindingToSync(result({ detail: "", suggestion: "install trivy" })).detail,
      "Fix: install trivy",
    );
  });

  it("leaves detail undefined rather than empty when there is neither", () => {
    // An empty string would render as a blank line in the ledger; undefined omits it.
    assert.equal(securityFindingToSync(result({ detail: "" })).detail, undefined);
  });
});

describe("advisoryFindings", () => {
  it("carries an advisory riding on a PASS result", () => {
    // The whole point of the advisory channel: catalog age and upstream releases must
    // reach a human without moving the verdict.
    const rows = [
      result({
        status: "pass",
        name: "bumblebee",
        advisory: { key: "adv:catalog-age", title: "catalogs are 38 days old", detail: "d" },
      }),
    ];
    assert.deepEqual(advisoryFindings(rows), [
      { dedupKey: "adv:catalog-age", title: "catalogs are 38 days old", detail: "d" },
    ]);
  });

  it("keys on the advisory's own key, not the check name", () => {
    const rows = [
      result({ name: "check-a", advisory: { key: "adv:shared", title: "t", detail: "d" } }),
      result({ name: "check-b", advisory: { key: "adv:shared", title: "t", detail: "d" } }),
    ];
    assert.deepEqual(
      advisoryFindings(rows).map((f) => f.dedupKey),
      ["adv:shared", "adv:shared"],
    );
  });

  it("ignores results with no advisory, whatever their status", () => {
    const rows = [
      result({ status: "fail", name: "no advisory here" }),
      result({ status: "pass", name: "nor here" }),
    ];
    assert.deepEqual(advisoryFindings(rows), []);
  });

  it("requires a detail on the advisory — the type does not allow omitting it", () => {
    // Pinned because the ledger row is the only place this text ever appears: an
    // advisory with no detail would be a title with no explanation of what to do.
    const rows = [result({ advisory: { key: "k", title: "t", detail: "why it matters" } })];
    assert.equal(advisoryFindings(rows)[0].detail, "why it matters");
  });

  it("returns an empty array for no input", () => {
    assert.deepEqual(advisoryFindings([]), []);
  });
});
