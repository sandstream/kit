import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseReviewComment,
  selectReviewComments,
  REVIEW_COMMENT_MARKER,
  type ReviewCommentInput,
} from "./review-comment.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const expected = {
  repository: "sandstream/kit",
  pullRequest: 652,
  head,
  baseBranch: "main",
  mergeBase: base,
};
const areas = ["correctness", "security", "tests", "public-hygiene", "adr"];
const finding = {
  severity: "P1",
  file: "src/example.ts",
  line: 7,
  scenario: "A user reads another user's data",
  evidence: "The lookup omits the owner check",
};

function report(changes: Record<string, unknown> = {}) {
  return {
    schema: "kit-independent-review/v1",
    repository: "sandstream/kit",
    pull_request: 652,
    base_branch: "main",
    base_tip: base,
    base,
    head,
    verdict: "pass",
    checks: areas.map((area) => ({ area, status: "pass", evidence: "Inspected" })),
    limits: [],
    findings: [],
    ...changes,
  };
}
function body(value: unknown) {
  return `${REVIEW_COMMENT_MARKER}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}
function comment(
  id: string,
  author: string,
  value: unknown,
  updatedAt = "2026-10-29T12:00:00Z",
): ReviewCommentInput {
  return {
    id,
    author,
    url: `https://github.com/sandstream/kit/pull/652#issuecomment-${id}`,
    createdAt: "2026-10-29T12:00:00Z",
    updatedAt,
    body: body(value),
  };
}
function found() {
  return report({
    verdict: "findings",
    findings: [finding],
    checks: areas.map((area) => ({
      area,
      status: area === "security" ? "issue" : "pass",
      evidence: "Inspected",
    })),
  });
}

describe("parseReviewComment", () => {
  it("accepts a valid report for the current pull request and merge base", () => {
    const parsed = parseReviewComment(body(report()), expected);
    assert.equal(parsed.kind, "current");
    if (parsed.kind === "current") assert.equal(parsed.report.verdict, "pass");
    assert.equal(
      parseReviewComment(body(report({ base_tip: "c".repeat(40) })), expected).kind,
      "current",
    );
  });

  it("does not treat ordinary comments, invalid fields, or unknown versions as a pass", () => {
    assert.equal(parseReviewComment("Just a comment", expected).kind, "unmarked");
    assert.equal(
      parseReviewComment("<!-- kit-independent-review:v2 -->\n{}", expected).kind,
      "invalid",
    );
    assert.equal(parseReviewComment(body(report({ verdict: "ok" })), expected).kind, "invalid");
    assert.equal(parseReviewComment(body(report({ head: "abc" })), expected).kind, "invalid");
    assert.equal(parseReviewComment(body(report({ checks: [] })), expected).kind, "invalid");
    assert.equal(
      parseReviewComment(body(report({ repository: "other/repo" })), expected).kind,
      "invalid",
    );
    assert.equal(parseReviewComment(body(report({ pull_request: 653 })), expected).kind, "invalid");
  });

  it("identifies stale heads and merge bases without accepting them", () => {
    assert.equal(
      parseReviewComment(body(report({ head: "c".repeat(40) })), expected).kind,
      "stale",
    );
    assert.equal(
      parseReviewComment(body(report({ base: "c".repeat(40) })), expected).kind,
      "stale",
    );
    assert.equal(
      parseReviewComment(body(report({ base_branch: "release" })), expected).kind,
      "stale",
    );
  });
});

describe("review verdict consistency", () => {
  it("rejects contradictory verdicts and incomplete findings", () => {
    assert.equal(
      parseReviewComment(body(report({ findings: [finding] })), expected).kind,
      "invalid",
    );
    assert.equal(
      parseReviewComment(body(report({ verdict: "findings" })), expected).kind,
      "invalid",
    );
    assert.equal(
      parseReviewComment(body(report({ verdict: "incomplete" })), expected).kind,
      "invalid",
    );
    assert.equal(parseReviewComment(body(found()), expected).kind, "current");
    assert.equal(
      parseReviewComment(body(found()), { ...expected, head: "c".repeat(40) }).kind,
      "stale",
    );
    assert.equal(
      parseReviewComment(
        body(report({ ...found(), findings: [{ ...finding, file: "../secret", line: 0 }] })),
        expected,
      ).kind,
      "invalid",
    );
  });

  it("keeps incomplete findings and rejects terminal control characters", () => {
    const incomplete = { ...found(), verdict: "incomplete", limits: ["Tests unavailable"] };
    assert.equal(parseReviewComment(body(incomplete), expected).kind, "current");
    assert.equal(
      parseReviewComment(
        body(
          report({
            checks: areas.map((area) => ({ area, status: "pass", evidence: "\u001b[2J" })),
          }),
        ),
        expected,
      ).kind,
      "invalid",
    );
  });
});

describe("selectReviewComments", () => {
  it("uses the latest numeric ID per author without allowing another author to hide findings", () => {
    const results = selectReviewComments(
      [
        comment("10", "alice", found()),
        comment("11", "bob", report()),
        comment("12", "ALICE", report()),
      ],
      expected,
    );
    assert.deepEqual(
      results.map((x) => x.comment.id),
      ["10", "11", "12"],
    );
    assert.equal(results[0]?.result.kind, "current");
    if (results[0]?.result.kind === "current")
      assert.equal(results[0].result.report.verdict, "findings");
  });

  it("allows a later pass to replace an incomplete report with no findings", () => {
    const incomplete = report({
      verdict: "incomplete",
      limits: ["Tests unavailable"],
      checks: areas.map((area) => ({
        area,
        status: area === "tests" ? "unverified" : "pass",
        evidence: "Inspected",
      })),
    });
    const results = selectReviewComments(
      [comment("2", "alice", incomplete), comment("10", "alice", report())],
      expected,
    );
    assert.deepEqual(
      results.map((x) => x.comment.id),
      ["10"],
    );
  });
});

describe("selectReviewComments invalid reports", () => {
  it("retains findings on the current head when the merge base changes", () => {
    const results = selectReviewComments(
      [
        comment("1", "alice", { ...found(), base: "c".repeat(40) }),
        comment("2", "alice", report()),
      ],
      expected,
    );
    assert.deepEqual(
      results.map((entry) => entry.comment.id),
      ["1", "2"],
    );
    assert.equal(results[0]?.result.kind, "stale");
    if (results[0]?.result.kind === "stale")
      assert.deepEqual(results[0].result.report.findings, [finding]);
    assert.equal(results[1]?.result.kind, "current");
  });

  it("retains an edited findings report when the same author later reports pass", () => {
    const results = selectReviewComments(
      [comment("1", "alice", found(), "2026-10-29T12:01:00Z"), comment("2", "alice", report())],
      expected,
    );
    assert.deepEqual(
      results.map((entry) => entry.comment.id),
      ["1", "2"],
    );
    assert.deepEqual(results[0]?.result, { kind: "invalid", reason: "review comment was edited" });
    assert.equal(results[1]?.result.kind, "current");
  });

  it("does not fall back to an older pass for a malformed, stale, or edited newer report", () => {
    const invalid = selectReviewComments(
      [comment("1", "alice", report()), comment("2", "alice", report({ verdict: "ok" }))],
      expected,
    );
    assert.equal(invalid[0]?.result.kind, "invalid");
    const stale = selectReviewComments(
      [comment("1", "alice", report()), comment("2", "alice", report({ head: "c".repeat(40) }))],
      expected,
    );
    assert.equal(stale[0]?.result.kind, "stale");
    const edited = selectReviewComments(
      [comment("1", "alice", report()), comment("2", "alice", report(), "2026-10-29T12:01:00Z")],
      expected,
    );
    assert.deepEqual(edited[0]?.result, { kind: "invalid", reason: "review comment was edited" });
    const brokenMarker = comment("2", "alice", report());
    brokenMarker.body = "<!-- kit-independent-review:v1";
    const malformed = selectReviewComments(
      [comment("1", "alice", report()), brokenMarker],
      expected,
    );
    assert.equal(malformed[0]?.result.kind, "invalid");
  });

  it("refuses duplicate IDs and malformed metadata", () => {
    assert.throws(
      () =>
        selectReviewComments(
          [comment("1", "alice", report()), comment("1", "bob", report())],
          expected,
        ),
      /duplicate/i,
    );
    assert.throws(
      () => selectReviewComments([comment("not-a-number", "alice", report())], expected),
      /metadata/i,
    );
  });
});
