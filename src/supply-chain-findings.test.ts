import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSupplyChainFindingLines, SUPPLY_CHAIN_FINDINGS_FILE } from "./check-security.js";
import { verifyAuditChain } from "./audit.js";
import type { BumblebeeFinding } from "./bumblebee.js";

function finding(over: Partial<BumblebeeFinding> = {}): BumblebeeFinding {
  return {
    severity: "high",
    catalogId: "shai-hulud",
    catalogName: "Shai-Hulud worm",
    ecosystem: "npm",
    packageName: "evil-pkg",
    version: "1.2.3",
    sourceFile: "package-lock.json",
    evidence: "matches known-compromise hash",
    ...over,
  };
}

describe("buildSupplyChainFindingLines", () => {
  it("emits one JSON line per finding with the expected shape", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const out = buildSupplyChainFindingLines(
      [finding(), finding({ packageName: "p2" })],
      "deep",
      now,
    );
    const lines = out.split("\n");
    assert.equal(lines.length, 2);
    const obj = JSON.parse(lines[0]);
    assert.equal(obj.event_type, "supply_chain_finding");
    assert.equal(obj.source, "bumblebee");
    assert.equal(obj.profile, "deep");
    assert.equal(obj.package, "evil-pkg");
    assert.equal(obj.timestamp, "2026-01-02T03:04:05.000Z");
    assert.equal(JSON.parse(lines[1]).package, "p2");
  });

  it("returns empty string for no findings (nothing to append)", () => {
    assert.equal(buildSupplyChainFindingLines([], "baseline"), "");
  });

  it("falls back to 'unknown' package and null fields when absent", () => {
    const obj = JSON.parse(
      buildSupplyChainFindingLines(
        [finding({ packageName: "", version: "", ecosystem: "", sourceFile: "", evidence: "" })],
        "baseline",
      ),
    );
    assert.equal(obj.package, "unknown");
    assert.equal(obj.version, null);
    assert.equal(obj.ecosystem, null);
    assert.equal(obj.source_file, null);
    assert.equal(obj.evidence, null);
  });

  it("produces UNCHAINED lines that must NOT go in the audit log (no prev/hash)", () => {
    // The whole point of the fix: these raw lines have no hash chain. If they
    // were appended to .kit-audit.jsonl, verifyAuditChain would report BROKEN.
    const out = buildSupplyChainFindingLines([finding()], "baseline");
    const obj = JSON.parse(out);
    assert.equal(obj.prev, undefined);
    assert.equal(obj.hash, undefined);

    const verdict = verifyAuditChain(out + "\n");
    assert.equal(verdict.ok, false, "raw findings must break the audit hash chain");
    assert.match(verdict.reason ?? "", /unchained|missing hash/i);
  });

  it("targets a separate sink file, not the chained audit log", () => {
    assert.equal(SUPPLY_CHAIN_FINDINGS_FILE, ".kit-findings.jsonl");
    assert.notEqual(SUPPLY_CHAIN_FINDINGS_FILE, ".kit-audit.jsonl");
  });
});
