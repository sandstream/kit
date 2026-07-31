import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffScans, classifyChange, checkKey, didRun } from "./scan-diff.js";
import type { JsonCheck, JsonCheckOutput } from "./cli-checks-shared.js";

const chk = (over: Partial<JsonCheck> & Pick<JsonCheck, "name" | "status">): JsonCheck => ({
  category: "security/dependency",
  detail: "",
  ...over,
});

const doc = (checks: JsonCheck[]): JsonCheckOutput => ({
  ok: checks.every((c) => c.status !== "fail"),
  checks,
  summary: { passed: 0, failed: 0, warnings: 0, skipped: 0 },
});

describe("checkKey", () => {
  it("is the same identity findings-track uses for PAL dedup", () => {
    assert.equal(
      checkKey({ category: "security/secrets", name: "secrets scan" }),
      "security/secrets:secrets scan",
    );
  });
});

describe("didRun", () => {
  it("a skip did not run, and didNotRun overrides an otherwise-real status", () => {
    assert.equal(didRun({ status: "pass" }), true);
    assert.equal(didRun({ status: "fail" }), true);
    assert.equal(didRun({ status: "warn" }), true);
    assert.equal(didRun({ status: "skip" }), false);
    assert.equal(
      didRun({ status: "warn", didNotRun: true }),
      false,
      "a crashed scanner did not run",
    );
  });
});

describe("the coverage axis — the reason this is not a generic differ", () => {
  it("fail → skip is LOST COVERAGE, never an improvement", () => {
    const d = diffScans(
      doc([chk({ name: "osv-scanner", status: "fail", severity: "high" })]),
      doc([chk({ name: "osv-scanner", status: "skip" })]),
    );
    assert.equal(d.changes[0].kind, "coverage-lost");
    assert.equal(d.worseThanBefore, true);
    assert.match(d.changes[0].summary, /unknown, not fixed/);
  });

  it("pass → didNotRun is lost coverage even though the status still reads warn/pass-ish", () => {
    const d = diffScans(
      doc([chk({ name: "trivy", status: "pass" })]),
      doc([chk({ name: "trivy", status: "warn", didNotRun: true })]),
    );
    assert.equal(d.changes[0].kind, "coverage-lost");
    assert.match(d.changes[0].summary, /could not run/);
  });

  it("lost coverage outranks a regression in the report order", () => {
    const d = diffScans(
      doc([
        chk({ name: "a-regression", status: "pass" }),
        chk({ name: "z-coverage", status: "pass" }),
      ]),
      doc([
        chk({ name: "a-regression", status: "fail" }),
        chk({ name: "z-coverage", status: "skip" }),
      ]),
    );
    assert.deepEqual(
      d.changes.map((c) => c.kind),
      ["coverage-lost", "regressed"],
      "worst-first, and unknown is worse than a known failure",
    );
  });

  it("a check that vanishes from the second document is surfaced, not ignored", () => {
    const d = diffScans(doc([chk({ name: "gone", status: "fail" })]), doc([]));
    assert.equal(d.changes[0].kind, "disappeared");
    assert.equal(d.worseThanBefore, true);
  });

  it("skip → ran is coverage gained", () => {
    const d = diffScans(
      doc([chk({ name: "trivy", status: "skip" })]),
      doc([chk({ name: "trivy", status: "warn" })]),
    );
    assert.equal(d.changes[0].kind, "coverage-gained");
    assert.equal(d.worseThanBefore, false, "looking again is not a regression");
  });

  it("skip → skip is unchanged, not repeatedly reported", () => {
    const d = diffScans(
      doc([chk({ name: "semgrep", status: "skip" })]),
      doc([chk({ name: "semgrep", status: "skip" })]),
    );
    assert.equal(d.changes[0].kind, "unchanged");
  });
});

describe("finding movement", () => {
  it("classifies the ordinary directions", () => {
    const c = (s: JsonCheck["status"]) => chk({ name: "x", status: s });
    assert.equal(classifyChange(c("pass"), c("fail")), "regressed");
    assert.equal(classifyChange(c("warn"), c("fail")), "regressed");
    assert.equal(classifyChange(c("fail"), c("warn")), "improved");
    assert.equal(classifyChange(c("fail"), c("pass")), "resolved");
    assert.equal(classifyChange(c("warn"), c("warn")), "unchanged");
  });

  it("severity moving under a stable status still counts", () => {
    const d = diffScans(
      doc([chk({ name: "cve", status: "warn", severity: "high" })]),
      doc([chk({ name: "cve", status: "warn", severity: "critical" })]),
    );
    assert.equal(d.changes[0].kind, "regressed");
    assert.deepEqual(d.changes[0].severityChanged, { from: "high", to: "critical" });
    assert.equal(d.worseThanBefore, true);
  });

  it("a new non-passing check is news; a new passing one is just coverage", () => {
    const added = (s: JsonCheck["status"]) =>
      diffScans(doc([]), doc([chk({ name: "n", status: s })]));
    assert.equal(added("fail").changes[0].kind, "appeared");
    assert.equal(added("pass").changes[0].kind, "coverage-gained");
    assert.equal(added("fail").clean, false, "a new failing check must not read as clean");
    assert.equal(added("pass").clean, true);
  });
});

describe("diff-level verdicts", () => {
  it("clean does NOT mean the second run is green", () => {
    const both = doc([chk({ name: "known", status: "fail", severity: "high" })]);
    const d = diffScans(both, both);
    assert.equal(d.clean, true, "nothing moved");
    assert.equal(d.worseThanBefore, false);
    assert.equal(d.changes[0].kind, "unchanged");
    assert.equal(both.ok, false, "…while the run itself is still failing");
  });

  it("counts every kind, including zeros, so the shape is stable for consumers", () => {
    const d = diffScans(doc([]), doc([]));
    assert.deepEqual(d.counts, {
      "coverage-lost": 0,
      disappeared: 0,
      regressed: 0,
      appeared: 0,
      "coverage-gained": 0,
      improved: 0,
      resolved: 0,
      unchanged: 0,
    });
    assert.equal(d.clean, true);
  });

  it("is deterministic and order-independent in its inputs", () => {
    const a = chk({ name: "alpha", status: "fail" });
    const b = chk({ name: "beta", status: "warn" });
    const one = diffScans(
      doc([a, b]),
      doc([
        { ...a, status: "pass" },
        { ...b, status: "fail" },
      ]),
    );
    const two = diffScans(
      doc([b, a]),
      doc([
        { ...b, status: "fail" },
        { ...a, status: "pass" },
      ]),
    );
    assert.deepEqual(
      one.changes.map((c) => c.summary),
      two.changes.map((c) => c.summary),
      "the same two runs must diff identically regardless of array order",
    );
  });

  it("tolerates a document with no checks array without inventing a clean answer", () => {
    // The command layer rejects these; the core must not crash if one slips through.
    const d = diffScans({ checks: undefined } as unknown as JsonCheckOutput, doc([]));
    assert.equal(d.changes.length, 0);
  });
});

describe("categories are part of identity", () => {
  it("the same check name in two categories is two different checks", () => {
    const d = diffScans(
      doc([chk({ category: "security/secrets", name: "scan", status: "pass" })]),
      doc([chk({ category: "security/exposure", name: "scan", status: "pass" })]),
    );
    assert.deepEqual(
      d.changes.map((c) => c.kind).sort(),
      ["coverage-gained", "disappeared"],
      "not a move — a removal plus an addition",
    );
  });
});
