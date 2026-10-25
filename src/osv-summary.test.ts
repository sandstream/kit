import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { osvFinding, osvSeverity } from "./osv-summary.js";

const pkg = (name: string, version: string, scores: string[], ecosystem = "npm") => ({
  package: { name, version, ecosystem },
  vulnerabilities: scores.map(() => ({})),
  groups: scores.map((max_severity) => ({ max_severity })),
});

const payload = (...packages: ReturnType<typeof pkg>[]) =>
  JSON.stringify({ results: [{ packages }] });

describe("osvSeverity", () => {
  it("maps the worst CVSS score to a level", () => {
    assert.equal(osvSeverity(9.8), "critical");
    assert.equal(osvSeverity(7), "high");
    assert.equal(osvSeverity(6.3), "medium");
    assert.equal(osvSeverity(3.7), "low");
  });
});

describe("osvFinding", () => {
  it("rates the row by the worst hole, not a fixed high", () => {
    const r = osvFinding(
      "osv-scanner (deps)",
      payload(
        pkg("fast-uri", "3.1.8", ["3.7", "6.1"]),
        pkg("hono", "4.13.7", ["5.3"]),
        pkg("ip-address", "10.7.2", ["6.3"]),
      ),
    );
    assert.equal(r.status, "warn");
    assert.equal(r.severity, "medium");
    assert.match(r.detail, /^4 known dependency vulnerability\(ies\) in 3 package\(s\)/);
    assert.match(r.detail, /worst CVSS 6\.3 \(medium\)/);
    assert.match(r.detail, /fast-uri 3\.1\.8, hono 4\.13\.7, ip-address 10\.7\.2/);
    assert.match(r.detail, /-run: osv-scanner -r \./);
  });

  it("rates a 9.8 critical", () => {
    const r = osvFinding("osv-scanner (deps)", payload(pkg("x", "1.0.0", ["9.8"])));
    assert.equal(r.severity, "critical");
  });

  it("keeps high when osv gives no score, and says so", () => {
    const r = osvFinding("osv-scanner (deps)", payload(pkg("x", "1.0.0", [""])));
    assert.equal(r.severity, "high");
    assert.match(r.detail, /no CVSS score/);
  });

  it("suggests an npm update only when every package is npm", () => {
    const npm = osvFinding(
      "osv-scanner (deps)",
      payload(pkg("a", "1.0.0", ["5"]), pkg("b", "2.0.0", ["5"])),
    );
    assert.match(npm.suggestion ?? "", /^npm update a b --ignore-scripts/);
    const mixed = osvFinding(
      "osv-scanner (deps)",
      payload(pkg("a", "1.0.0", ["5"]), pkg("g", "1.0.0", ["5"], "Go")),
    );
    assert.equal(mixed.suggestion, undefined);
  });

  it("never rates below high when one hole has no score, even if the others are low", () => {
    const r = osvFinding(
      "osv-scanner (deps)",
      payload(pkg("a", "1.0.0", ["2.0"]), pkg("b", "1.0.0", [""])),
    );
    assert.equal(r.severity, "high");
    assert.match(r.detail, /1 without a CVSS score/);
  });

  it("keeps a higher score above the unscored floor", () => {
    const r = osvFinding(
      "osv-scanner (deps)",
      payload(pkg("a", "1.0.0", ["9.1"]), pkg("b", "1.0.0", [""])),
    );
    assert.equal(r.severity, "critical");
  });
});

describe("osvFinding: untrusted lockfile text and malware", () => {
  it("rates a malware advisory (MAL- id) critical whatever its score", () => {
    const evil = {
      package: { name: "evil", version: "1.0.0", ecosystem: "npm" },
      vulnerabilities: [{ id: "MAL-2026-1" }],
      groups: [{ max_severity: "" }],
    };
    const r = osvFinding("osv-scanner (deps)", payload(evil as never));
    assert.equal(r.severity, "critical");
  });

  it("drops control characters and odd names from the row and from the command", () => {
    const r = osvFinding(
      "osv-scanner (deps)",
      payload(
        pkg("evil\u001b[2J\nname", "1.0.0\u0007", ["5"]),
        pkg("x; rm -rf ~", "1.0.0", ["5"]),
        pkg("ok", "2.0.0", ["5"]),
      ),
    );
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(r.detail));
    assert.ok(!r.detail.includes("rm -rf"));
    assert.equal(r.suggestion, undefined);
  });

  it("lists at most ten packages and keeps the row short", () => {
    const many = Array.from({ length: 25 }, (_, i) => pkg(`p${i}`, "1.0.0", ["5"]));
    const r = osvFinding("osv-scanner (deps)", payload(...many));
    assert.match(r.detail, /\+15 more/);
    assert.ok(r.detail.length < 600);
  });
});
