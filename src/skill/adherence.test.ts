import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOutOfScope,
  summarizeEvidence,
  checkAdherence,
  checkNegativeControls,
  auditRuntime,
  type ObservedAction,
  type RuntimeEvidence,
} from "./adherence.js";

const SCOPE = ["Read", "Bash", "WebFetch"];

const ev = (actions: ObservedAction[], over: Partial<RuntimeEvidence> = {}): RuntimeEvidence => ({
  actions,
  runs: over.runs ?? 1,
  sessions: over.sessions ?? 1,
  confidence: over.confidence ?? "span",
});

describe("isOutOfScope", () => {
  it("flags a tool not in a bounded scope", () => {
    assert.equal(isOutOfScope({ tool: "Edit", denied: false }, SCOPE), true);
    assert.equal(isOutOfScope({ tool: "Read", denied: false }, SCOPE), false);
  });
  it("does not judge tool-scope when allowedTools is undefined (broker verdict still applies)", () => {
    assert.equal(isOutOfScope({ tool: "Edit", denied: false }, undefined), false);
    assert.equal(
      isOutOfScope({ tool: "WebFetch", brokerVerdict: "out-of-scope", denied: false }, undefined),
      true,
    );
  });
  it("flags an out-of-scope broker verdict even for an allowed tool", () => {
    assert.equal(
      isOutOfScope({ tool: "WebFetch", brokerVerdict: "out-of-scope", denied: false }, SCOPE),
      true,
    );
    assert.equal(
      isOutOfScope({ tool: "WebFetch", brokerVerdict: "in-scope", denied: false }, SCOPE),
      false,
    );
  });
});

describe("summarizeEvidence", () => {
  it("counts violations (ran) vs deniedForbidden (blocked)", () => {
    const s = summarizeEvidence(
      SCOPE,
      ev([
        { tool: "Read", denied: false }, // in scope
        { tool: "Edit", denied: false }, // out of scope, RAN → violation
        { tool: "Edit", denied: true }, // out of scope, DENIED → deniedForbidden
        { tool: "WebFetch", brokerVerdict: "out-of-scope", denied: true }, // denied
      ]),
    );
    assert.equal(s.actions, 4);
    assert.equal(s.violations, 1);
    assert.equal(s.deniedForbidden, 2);
  });
});

describe("checkAdherence", () => {
  it("skips with no recorded runs", () => {
    assert.equal(checkAdherence(SCOPE, ev([], { runs: 0 })).status, "skip");
  });
  it("passes when every action is in scope", () => {
    const r = checkAdherence(SCOPE, ev([{ tool: "Read", denied: false }], { runs: 3 }));
    assert.equal(r.status, "pass");
    assert.match(r.detail, /3 observed run/);
  });
  it("fails when an out-of-scope action ran (span confidence)", () => {
    const r = checkAdherence(SCOPE, ev([{ tool: "Edit", denied: false }]));
    assert.equal(r.status, "fail");
    assert.match(r.detail, /out-of-scope/);
  });
  it("a denied out-of-scope action is NOT an adherence violation", () => {
    const r = checkAdherence(SCOPE, ev([{ tool: "Edit", denied: true }]));
    assert.equal(r.status, "pass");
  });
  it("downgrades a would-be fail to inconclusive skip under session confidence", () => {
    const r = checkAdherence(
      SCOPE,
      ev([{ tool: "Edit", denied: false }], { confidence: "session" }),
    );
    assert.equal(r.status, "skip");
    assert.match(r.detail, /inconclusive/);
  });
  it("notes low confidence on a clean pass", () => {
    const r = checkAdherence(
      SCOPE,
      ev([{ tool: "Read", denied: false }], { confidence: "session" }),
    );
    assert.equal(r.status, "pass");
    assert.match(r.detail, /low confidence/);
  });
});

describe("checkNegativeControls", () => {
  it("skips with no recorded runs", () => {
    assert.equal(checkNegativeControls(SCOPE, ev([], { runs: 0 })).status, "skip");
  });
  it("passes with evidence when a forbidden action was denied", () => {
    const r = checkNegativeControls(SCOPE, ev([{ tool: "Edit", denied: true }], { runs: 2 }));
    assert.equal(r.status, "pass");
    assert.match(r.detail, /denied across 2 run/);
  });
  it("fails when a forbidden action succeeded", () => {
    const r = checkNegativeControls(SCOPE, ev([{ tool: "Edit", denied: false }]));
    assert.equal(r.status, "fail");
    assert.match(r.detail, /control absent/);
  });
  it("skips (not pass) when no forbidden action was ever attempted", () => {
    const r = checkNegativeControls(SCOPE, ev([{ tool: "Read", denied: false }]));
    assert.equal(r.status, "skip");
    assert.match(r.detail, /not exercised/);
  });
  it("inconclusive skip under session confidence for a would-be fail", () => {
    const r = checkNegativeControls(
      SCOPE,
      ev([{ tool: "Edit", denied: false }], { confidence: "session" }),
    );
    assert.equal(r.status, "skip");
    assert.match(r.detail, /inconclusive/);
  });
});

describe("auditRuntime", () => {
  it("returns both checks plus the evidence summary", () => {
    const a = auditRuntime(
      SCOPE,
      ev([
        { tool: "Read", denied: false },
        { tool: "Edit", denied: true },
      ]),
    );
    assert.deepEqual(
      a.checks.map((c) => c.id),
      ["adherence", "negative"],
    );
    assert.equal(a.checks[0].status, "pass"); // nothing out-of-scope ran
    assert.equal(a.checks[1].status, "pass"); // a forbidden attempt was denied
    assert.equal(a.summary.deniedForbidden, 1);
    assert.equal(a.summary.violations, 0);
  });

  it("a real violation fails adherence AND negative controls", () => {
    const a = auditRuntime(SCOPE, ev([{ tool: "Edit", denied: false }]));
    assert.equal(a.checks[0].status, "fail");
    assert.equal(a.checks[1].status, "fail");
  });
});
