import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectPrEscalations,
  formatReportedReviewPasses,
  type PrEscalationEvidence,
} from "./escalate-pr.js";
import type { SelectedReviewComment } from "./review-comment.js";

const HEAD = "a".repeat(40);
const goodCheck = {
  name: "build-and-test",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  url: "https://example.test/ci",
};

function passReview(): SelectedReviewComment {
  return {
    comment: {
      id: "123",
      url: "https://github.com/sandstream/kit/pull/650#issuecomment-123",
      author: "reviewer",
      createdAt: "2026-10-29T12:00:00Z",
      updatedAt: "2026-10-29T12:00:00Z",
      body: "",
    },
    result: {
      kind: "current",
      report: {
        repository: "sandstream/kit",
        pullRequest: 650,
        head: HEAD,
        baseBranch: "main",
        baseTip: HEAD,
        mergeBase: HEAD,
        verdict: "pass",
        checks: [],
        limits: [],
        findings: [],
      },
    },
  };
}

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
    reviewComments: [passReview()],
    humanApproved: false,
    mergeDenied: false,
    ...changes,
  };
}

describe("collectPrEscalations", () => {
  it("reports a missing, unavailable, stale, or malformed independent review", () => {
    const missing = collectPrEscalations(evidence({ reviewComments: [] }));
    assert.match(missing[0]?.issue ?? "", /no independent review/i);
    const unavailable = collectPrEscalations(
      evidence({ reviewCommentProblem: "GitHub comments unavailable" }),
    );
    assert.match(unavailable[0]?.issue ?? "", /unavailable/i);
    const comment = passReview();
    if (comment.result.kind !== "current") throw new Error("expected current report");
    for (const kind of ["stale", "invalid"] as const) {
      const result =
        kind === "stale"
          ? { kind, reason: "stale report", report: comment.result.report }
          : { kind, reason: "invalid report" };
      const items = collectPrEscalations(evidence({ reviewComments: [{ ...comment, result }] }));
      assert.match(items[0]?.issue ?? "", new RegExp(kind));
    }
  });
});

describe("independent review findings", () => {
  it("keeps findings visible when the base changes without a new head", () => {
    const review = passReview();
    if (review.result.kind !== "current") throw new Error("expected current report");
    review.result.report.verdict = "findings";
    review.result.report.findings = [
      {
        severity: "P1",
        file: "src/x.ts",
        line: 9,
        scenario: "Missing access check",
        evidence: "Reproduced",
      },
    ];
    const stale: SelectedReviewComment = {
      ...review,
      result: {
        kind: "stale",
        reason: "review comment is for a different base",
        report: review.result.report,
      },
    };
    const items = collectPrEscalations(evidence({ reviewComments: [stale, passReview()] }));
    assert.equal(items.length, 2);
    assert.match(items[0]?.issue ?? "", /different base/);
    assert.match(items[1]?.issue ?? "", /src\/x.ts:9.*Missing access check/);
    assert.equal(
      formatReportedReviewPasses(evidence({ reviewComments: [stale, passReview()] })),
      "",
    );
  });

  it("reports incomplete checks and all findings without terminal control characters", () => {
    const review = passReview();
    if (review.result.kind !== "current") throw new Error("expected current report");
    review.result.report.verdict = "incomplete";
    review.result.report.limits = ["Test\nnot run"];
    review.result.report.findings = [
      {
        severity: "P1",
        file: "src/x.ts",
        line: 12,
        scenario: "Unsafe\u001b\ninput",
        evidence: "Reproduced",
      },
    ];
    const items = collectPrEscalations(evidence({ reviewComments: [review] }));
    assert.equal(items.length, 2);
    assert.match(items[0]?.issue ?? "", /incomplete.*Test not run/i);
    assert.match(items[1]?.issue ?? "", /src\/x.ts:12.*Unsafe input/);
    assert.doesNotMatch(items[1]?.issue ?? "", /\u001b/);
    assert.match(items[1]?.action ?? "", /accept it in writing/i);
  });
});

describe("reported review pass", () => {
  it("labels a reported pass without claiming approval or independence", () => {
    const summary = formatReportedReviewPasses(evidence());
    assert.match(summary, /reviewer/);
    assert.match(summary, /does not prove independence or approve a merge/i);
    assert.equal(formatReportedReviewPasses(evidence({ reviewCommentProblem: "offline" })), "");
    const comment = passReview();
    assert.equal(
      formatReportedReviewPasses(
        evidence({
          reviewComments: [
            passReview(),
            { ...comment, result: { kind: "invalid", reason: "bad" } },
          ],
        }),
      ),
      "",
    );
  });
});

describe("receipt escalation", () => {
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
});

describe("CI and review thread escalation", () => {
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
