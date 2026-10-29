import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubPrView, parseGitHubReviewThreads } from "./review-receipt-github.js";

describe("GitHub review receipt evidence", () => {
  it("reads every check and changed path from the PR head", () => {
    const pr = parseGitHubPrView(
      JSON.stringify({
        number: 12,
        headRefOid: "a".repeat(40),
        changedFiles: 2,
        files: [{ path: "src/a.ts" }, { path: ".github/workflows/ci.yml" }],
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "CI",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://example.test/ci",
          },
          {
            __typename: "StatusContext",
            context: "security",
            state: "PENDING",
            targetUrl: "https://example.test/security",
          },
        ],
      }),
    );
    assert.equal(pr.number, 12);
    assert.deepEqual(pr.changedPaths, ["src/a.ts", ".github/workflows/ci.yml"]);
    assert.deepEqual(
      pr.checks.map((check) => [check.name, check.status, check.conclusion]),
      [
        ["CI", "COMPLETED", "SUCCESS"],
        ["security", "PENDING", "PENDING"],
      ],
    );
  });

  it("refuses an incomplete changed-file list", () => {
    assert.throws(
      () =>
        parseGitHubPrView(
          JSON.stringify({
            number: 12,
            headRefOid: "a".repeat(40),
            changedFiles: 2,
            files: [{ path: "src/a.ts" }],
            statusCheckRollup: [],
          }),
        ),
      /incomplete/i,
    );
  });

  it("keeps open and resolved threads but never prints comment text", () => {
    const threads = parseGitHubReviewThreads(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                totalCount: 2,
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    id: "one",
                    isResolved: false,
                    path: "src/a.ts",
                    line: 7,
                    resolvedBy: null,
                    comments: {
                      pageInfo: { hasNextPage: false },
                      nodes: [{ url: "https://example.test/one", body: "open finding" }],
                    },
                  },
                  {
                    id: "two",
                    isResolved: true,
                    path: "src/b.ts",
                    line: 8,
                    resolvedBy: { login: "reviewer" },
                    comments: {
                      pageInfo: { hasNextPage: false },
                      nodes: [{ url: "https://example.test/two", body: "fixed in commit" }],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    assert.equal(threads.length, 2);
    assert.equal(threads[0]?.resolved, false);
    assert.equal(threads[1]?.resolvedBy, "reviewer");
    assert.equal(threads[1]?.comments[0]?.body, "fixed in commit");
  });

  it("refuses truncated review threads or comments", () => {
    const truncated = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              totalCount: 1,
              pageInfo: { hasNextPage: true },
              nodes: [],
            },
          },
        },
      },
    };
    assert.throws(() => parseGitHubReviewThreads(JSON.stringify(truncated)), /incomplete/i);
  });
});
