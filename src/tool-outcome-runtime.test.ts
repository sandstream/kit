import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditRuntime, type RuntimeEvidence } from "./skill/adherence.js";
import { attributeRuns, targetSpanWindows, type ToolCallRow } from "./skill/attribute.js";

const evidence = (actions: RuntimeEvidence["actions"]): RuntimeEvidence => ({
  actions,
  runs: 1,
  sessions: 1,
  confidence: "span",
});

const row = (
  tool: string,
  outcome: ToolCallRow["outcome"],
  opensSkill: string | null = null,
  timestamp = "t1",
): ToolCallRow => ({
  sessionId: "s1",
  tool,
  outcome,
  opensSkill,
  timestamp,
  input: null,
});

describe("runtime skill boundaries", () => {
  it("does not turn a legacy Skill request into a run or a denial attribution window", () => {
    const rows = [row("Skill", undefined, "x"), row("Write", "returned")];
    const ev = attributeRuns(rows, "x");
    assert.equal(ev.runs, 0);
    assert.deepEqual(ev.actions, []);
    assert.equal(ev.unresolvedInvocations, 1);
    assert.equal(ev.unattributedActions, 1);
    assert.deepEqual(targetSpanWindows(rows, "x"), []);
    const report = auditRuntime(["Read"], ev);
    assert.deepEqual(
      report.checks.map((check) => check.status),
      ["skip", "skip"],
    );
    for (const check of report.checks) assert.match(check.detail, /unresolved Skill/);
  });

  it("does not open a denied skill or close the previous returned skill", () => {
    const rows = [
      row("Skill", "returned", "x", "t1"),
      row("Skill", "denied", "y", "t2"),
      row("Read", "returned", null, "t3"),
    ];
    assert.deepEqual(
      attributeRuns(rows, "x").actions.map((action) => action.tool),
      ["Read"],
    );
    assert.deepEqual(targetSpanWindows(rows, "x"), [{ sessionId: "s1", start: "t1", end: "" }]);
    const denied = attributeRuns(rows, "y");
    assert.equal(denied.runs, 0);
    assert.equal(denied.deniedInvocations, 1);
    assert.equal(denied.unresolvedInvocations, 0);
    assert.deepEqual(targetSpanWindows(rows, "y"), []);
    for (const check of auditRuntime(["Read"], denied).checks)
      assert.match(check.detail, /1 denied Skill invocation/);
  });

  for (const outcome of ["unknown", "error", "conflict", "returned"] as const) {
    it(`ends certain attribution at a ${outcome} Skill request with no identifiable skill`, () => {
      const rows = [
        row("Skill", "returned", "x", "t1"),
        row("Read", "returned", null, "t2"),
        row("Skill", outcome, null, "t3"),
        row("Write", "returned", null, "t4"),
      ];
      const ev = attributeRuns(rows, "x");
      assert.deepEqual(
        ev.actions.map((action) => action.tool),
        ["Read"],
      );
      assert.equal(ev.unresolvedInvocations, 1);
      assert.equal(ev.unattributedActions, 1);
      assert.deepEqual(targetSpanWindows(rows, "x"), [{ sessionId: "s1", start: "t1", end: "t3" }]);
      assert.deepEqual(
        auditRuntime(["Read"], ev).checks.map((check) => check.status),
        ["skip", "skip"],
      );
    });
  }

  it("never fabricates a denial time window from missing boundary timestamps", () => {
    assert.deepEqual(targetSpanWindows([row("Skill", "returned", "x", "")], "x"), []);
    assert.deepEqual(
      targetSpanWindows(
        [row("Skill", "returned", "x", "t1"), row("Skill", "unknown", "y", "")],
        "x",
      ),
      [],
    );
  });
});

describe("runtime result evidence", () => {
  it("keeps a legacy request inconclusive when denied is false and no result exists", () => {
    const report = auditRuntime(["Read"], evidence([{ tool: "Write", denied: false }]));
    assert.equal(report.summary.violations, 0);
    assert.equal(report.summary.deniedForbidden, 0);
    assert.equal(report.summary.inconclusiveForbidden, 1);
    assert.equal(report.summary.outcomes.unknown, 1);
    assert.deepEqual(
      report.checks.map((check) => check.status),
      ["skip", "skip"],
    );
    for (const check of report.checks) assert.match(check.detail, /unknown.*inconclusive/);
  });

  it("reports a returned result outside scope without claiming execution or effects", () => {
    const report = auditRuntime(
      ["Read"],
      evidence([
        { tool: "Write", denied: false, outcome: "returned" },
        { tool: "Read", denied: false, outcome: "unknown" },
      ]),
    );
    assert.equal(report.summary.violations, 1);
    assert.deepEqual(
      report.checks.map((check) => check.status),
      ["fail", "fail"],
    );
    for (const check of report.checks) {
      assert.match(check.detail, /recorded returned result/);
      assert.match(check.detail, /1 unknown/);
      assert.doesNotMatch(check.detail, /succeeded|actually ran|action\(s\) ran|control absent/);
    }
  });

  for (const outcome of ["unknown", "error", "conflict"] as const) {
    for (const tool of ["Read", "Write"]) {
      it(`keeps ${outcome} for ${tool} visible even alongside a proven denial`, () => {
        const report = auditRuntime(
          ["Read"],
          evidence([
            { tool, denied: false, outcome },
            { tool: "Write", denied: true },
          ]),
        );
        assert.equal(report.summary.violations, 0);
        assert.equal(report.summary.deniedForbidden, 1);
        assert.equal(report.summary.outcomes[outcome], 1);
        assert.equal(report.summary.inconclusiveForbidden, tool === "Write" ? 1 : 0);
        assert.deepEqual(
          report.checks.map((check) => check.status),
          ["skip", "skip"],
        );
        for (const check of report.checks) assert.match(check.detail, new RegExp(`1 ${outcome}`));
      });
    }
  }
});

describe("runtime denial evidence", () => {
  it("accepts both legacy proven denials and structured denied outcomes", () => {
    const report = auditRuntime(
      ["Read"],
      evidence([
        { tool: "Write", denied: true },
        { tool: "Write", denied: false, outcome: "denied" },
      ]),
    );
    assert.equal(report.summary.deniedForbidden, 2);
    assert.equal(report.summary.outcomes.denied, 2);
    assert.deepEqual(
      report.checks.map((check) => check.status),
      ["pass", "pass"],
    );
  });

  it("does not resolve contradictory denial and returned evidence into a verdict", () => {
    const report = auditRuntime(
      ["Read"],
      evidence([{ tool: "Write", denied: true, outcome: "returned" }]),
    );
    assert.equal(report.summary.outcomes.conflict, 1);
    assert.equal(report.summary.violations, 0);
    assert.equal(report.summary.deniedForbidden, 0);
    assert.deepEqual(
      report.checks.map((check) => check.status),
      ["skip", "skip"],
    );
  });
});
