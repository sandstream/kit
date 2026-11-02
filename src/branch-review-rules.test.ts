/**
 * A protected default branch that requires 0 approvals lets any writer merge its own pull
 * request. kit's own main was in that state while `gha-audit` reported it as a pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditRemoteRequiredReviews } from "./branch-protection-audit.js";
import {
  approvalsFromClassic,
  approvalsFromRules,
  reviewRequirement,
} from "./branch-review-rules.js";

const prRule = (n: unknown) => ({
  type: "pull_request",
  parameters: { required_approving_review_count: n },
});

function github(responses: Record<string, { status: number; body: unknown }>) {
  const urls: string[] = [];
  const fetcher = async (input: string) => {
    urls.push(input);
    const hit = Object.entries(responses).find(([suffix]) => input.endsWith(suffix));
    if (!hit) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit[1].body), { status: hit[1].status });
  };
  return { urls, fetcher };
}

describe("required approvals from branch rules", () => {
  it("takes the strictest pull-request rule and ignores other rule types", () => {
    assert.equal(approvalsFromRules([{ type: "deletion" }, prRule(0), prRule(2)]), 2);
    assert.equal(approvalsFromRules([{ type: "non_fast_forward" }]), null);
    assert.equal(approvalsFromRules({ not: "an array" }), null);
    assert.equal(approvalsFromRules([prRule("1")]), 0);
  });

  it("reads classic protection's count only when it is a whole number", () => {
    assert.equal(approvalsFromClassic({ required_approving_review_count: 1 }), 1);
    assert.equal(approvalsFromClassic({ required_approving_review_count: -1 }), null);
    assert.equal(approvalsFromClassic(null), null);
  });

  it("warns at 0 approvals, passes at 1, and stays unverified with no source", () => {
    const zero = reviewRequirement("main", 0, null);
    assert.equal(zero.status, "warn");
    assert.equal(zero.severity, "medium");
    assert.match(zero.detail, /0 approvals required/);
    assert.equal(zero.didNotRun, undefined);
    assert.equal(reviewRequirement("main", 0, 1).status, "pass");
    const none = reviewRequirement("main", null, null);
    assert.equal(none.status, "warn");
    assert.equal(none.didNotRun, true);
  });
});

describe("auditRemoteRequiredReviews", () => {
  it("reads the default branch's rules and reports 0 approvals", async () => {
    const { urls, fetcher } = github({
      "/repos/owner/repo": { status: 200, body: { default_branch: "main" } },
      "/rules/branches/main": { status: 200, body: [{ type: "deletion" }, prRule(0)] },
      "/required_pull_request_reviews": { status: 403, body: { message: "no" } },
    });
    const row = await auditRemoteRequiredReviews("git@github.com:owner/repo.git", "t", fetcher);
    assert.equal(row.status, "warn");
    assert.match(row.detail, /main: 0 approvals required/);
    assert.deepEqual(urls, [
      "https://api.github.com/repos/owner/repo",
      "https://api.github.com/repos/owner/repo/rules/branches/main",
      "https://api.github.com/repos/owner/repo/branches/main/protection/required_pull_request_reviews",
    ]);
  });

  it("counts classic protection when an admin token can read it", async () => {
    const { fetcher } = github({
      "/repos/owner/repo": { status: 200, body: { default_branch: "trunk" } },
      "/rules/branches/trunk": { status: 200, body: [] },
      "/required_pull_request_reviews": {
        status: 200,
        body: { required_approving_review_count: 1 },
      },
    });
    const row = await auditRemoteRequiredReviews("https://github.com/owner/repo", "t", fetcher);
    assert.equal(row.status, "pass");
    assert.match(row.detail, /trunk: 1 approval\(s\) required/);
  });

  it("does not call the API without a token or for GitLab", async () => {
    let called = false;
    const fetcher = async () => {
      called = true;
      return new Response("{}");
    };
    const noToken = await auditRemoteRequiredReviews("git@github.com:o/r.git", null, fetcher);
    const gitlab = await auditRemoteRequiredReviews("https://gitlab.com/g/r.git", "t", fetcher);
    assert.equal(noToken.didNotRun, true);
    assert.equal(gitlab.didNotRun, true);
    assert.equal(called, false);
  });
});
