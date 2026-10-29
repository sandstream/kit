import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectPrEscalations, type PrEscalationEvidence } from "./escalate-pr.js";

const HEAD = "a".repeat(40);
const goodCheck = {
  name: "build-and-test",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  url: "https://example.test/ci",
};

function evidence(changes: Partial<PrEscalationEvidence> = {}): PrEscalationEvidence {
  return {
    repo: "sandstream/kit",
    pr: 650,
    head: HEAD,
    receiptProblem: null,
    historyProblem: null,
    gate: {
      command: "kit review --receipt",
      exitCode: 0,
      outputSha256: "f".repeat(64),
      failures: [],
    },
    failedGateRuns: 0,
    checks: [goodCheck],
    threads: [],
    protectedPaths: [],
    humanApproved: false,
    mergeDenied: false,
    ...changes,
  };
}

describe("collectPrEscalations", () => {
  it("reports a missing or invalid receipt with the recovery command", () => {
    const missing = collectPrEscalations(
      evidence({ receiptProblem: "receipt missing", gate: null }),
    );
    assert.equal(missing[0]?.category, "pr");
    assert.match(missing[0]?.action ?? "", /kit review --receipt/);
    const invalid = collectPrEscalations(
      evidence({ receiptProblem: "receipt signature is invalid", gate: null }),
    );
    assert.match(invalid[0]?.issue ?? "", /signature/);
  });

  it("keeps an invalid run history visible", () => {
    const items = collectPrEscalations(
      evidence({ historyProblem: "history signature is invalid" }),
    );
    assert.match(items[0]?.issue ?? "", /history signature/);
    assert.match(items[0]?.action ?? "", /Inspect/);
  });

  it("escalates the same failed gate only after two recorded runs", () => {
    const gate = {
      command: "kit review --receipt",
      exitCode: 1,
      outputSha256: "f".repeat(64),
      failures: ["standards: complexity in src/x.ts"],
    };
    assert.deepEqual(collectPrEscalations(evidence({ gate, failedGateRuns: 1 })), []);
    const items = collectPrEscalations(evidence({ gate, failedGateRuns: 2 }));
    assert.match(items[0]?.issue ?? "", /standards: complexity/);
    assert.match(items[0]?.action ?? "", /kit review --receipt/);
  });

  it("names failed CI checks, review findings, and protected paths", () => {
    const items = collectPrEscalations(
      evidence({
        checks: [{ ...goodCheck, conclusion: "FAILURE" }],
        threads: [
          {
            path: "src/x.ts",
            line: 12,
            url: "https://example.test/thread",
            scenario: "Unsafe input",
            resolved: false,
          },
        ],
        protectedPaths: [{ path: ".github/workflows/ci.yml", classes: ["github"] }],
      }),
    );
    assert.equal(items.length, 3);
    assert.match(items[0]?.action ?? "", /example.test\/ci/);
    assert.match(items[1]?.issue ?? "", /src\/x.ts:12.*Unsafe input/);
    assert.match(items[2]?.action ?? "", /human.*approve/i);
  });

  it("clears protected paths after a current human approval", () => {
    const items = collectPrEscalations(
      evidence({
        protectedPaths: [{ path: ".github/kit-protected-paths.json", classes: ["github"] }],
        humanApproved: true,
      }),
    );
    assert.deepEqual(items, []);
  });

  it("reports pending CI without calling it a failure, and names a denied merge", () => {
    const items = collectPrEscalations(
      evidence({
        checks: [{ ...goodCheck, status: "IN_PROGRESS", conclusion: "" }],
        mergeDenied: true,
      }),
    );
    assert.match(items[0]?.issue ?? "", /pending/i);
    assert.match(items[1]?.action ?? "", /gh pr merge 650 --squash/);
  });
});
