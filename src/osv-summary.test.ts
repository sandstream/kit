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
});
