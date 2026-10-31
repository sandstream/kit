import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCurrentHumanApproval } from "./escalate-pr-github.js";

const HEAD = "a".repeat(40);

function response(reviews: unknown[], hasNextPage = false) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          author: { login: "sandstream" },
          latestOpinionatedReviews: {
            totalCount: reviews.length,
            pageInfo: { hasNextPage },
            nodes: reviews,
          },
        },
      },
    },
  });
}

function review(login: string, state: string, head = HEAD, type = "User") {
  return { author: { __typename: type, login }, state, commit: { oid: head } };
}

describe("parseCurrentHumanApproval", () => {
  it("accepts a different human who approved the exact head", () => {
    assert.equal(parseCurrentHumanApproval(response([review("alice", "APPROVED")]), HEAD), true);
  });

  it("rejects author, bot, stale, and superseded approvals", () => {
    assert.equal(
      parseCurrentHumanApproval(response([review("sandstream", "APPROVED")]), HEAD),
      false,
    );
    assert.equal(
      parseCurrentHumanApproval(response([review("SandStream", "APPROVED")]), HEAD),
      false,
    );
    assert.equal(
      parseCurrentHumanApproval(response([review("ci[bot]", "APPROVED", HEAD, "Bot")]), HEAD),
      false,
    );
    assert.equal(
      parseCurrentHumanApproval(response([review("alice", "APPROVED", "b".repeat(40))]), HEAD),
      false,
    );
    assert.equal(
      parseCurrentHumanApproval(response([review("alice", "CHANGES_REQUESTED")]), HEAD),
      false,
    );
  });

  it("refuses incomplete review evidence", () => {
    assert.throws(() => parseCurrentHumanApproval(response([], true), HEAD), /incomplete/i);
  });
});
