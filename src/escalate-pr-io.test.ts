import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPrEvidence, receiptMatchesCurrent } from "./escalate-pr-io.js";
import type { ReadCommand } from "./review-receipt-io.js";
import { buildReviewReceipt } from "./review-receipt.js";

const HEAD = "a".repeat(40);

function fakeCommands(root: string, remoteHead = HEAD): ReadCommand {
  return (command, args) => {
    const call = [command, ...args].join(" ");
    if (call === "git rev-parse --show-toplevel") return root + "\n";
    if (call === "git rev-parse HEAD") return HEAD + "\n";
    if (call === "git status --porcelain --untracked-files=all") return "";
    if (call === "gh repo view --json nameWithOwner") return '{"nameWithOwner":"sandstream/kit"}';
    if (call.startsWith("gh pr view --json "))
      return JSON.stringify({
        number: 12,
        headRefOid: remoteHead,
        changedFiles: 1,
        files: [{ path: ".github/workflows/ci.yml" }],
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "CI",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://example.test/ci",
          },
        ],
      });
    if (call.startsWith("gh api graphql "))
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              author: { login: "sandstream" },
              latestOpinionatedReviews: {
                totalCount: 0,
                pageInfo: { hasNextPage: false },
                nodes: [],
              },
              reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
            },
          },
        },
      });
    throw new Error(`unexpected command: ${call}`);
  };
}

describe("collectPrEvidence", () => {
  it("uses live CI and shipped protection rules when no receipt exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-escalate-pr-"));
    try {
      const evidence = await collectPrEvidence(root, { mergeDenied: false }, fakeCommands(root));
      assert.match(evidence.receiptProblem ?? "", /missing/i);
      assert.equal(evidence.checks[0]?.conclusion, "FAILURE");
      assert.deepEqual(evidence.protectedPaths, [
        { path: ".github/workflows/ci.yml", classes: ["github"] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a local branch that differs from the PR head", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-escalate-pr-stale-"));
    try {
      await assert.rejects(
        collectPrEvidence(root, { mergeDenied: false }, fakeCommands(root, "b".repeat(40))),
        /local commit/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("receiptMatchesCurrent", () => {
  it("detects changed CI and review findings on the same commit", () => {
    const checks = [
      { name: "CI", status: "COMPLETED", conclusion: "SUCCESS", url: "https://example.test/ci" },
    ];
    const threads = [
      {
        id: "one",
        path: "src/x.ts",
        line: 7,
        resolved: false,
        resolvedBy: null,
        comments: [{ url: "https://example.test/thread", body: "Unsafe input" }],
      },
    ];
    const input = {
      repo: "sandstream/kit",
      pr: 12,
      localHead: HEAD,
      remoteHead: HEAD,
      createdAt: "2026-10-29T10:00:00.000Z",
      gate: { command: "kit review --receipt", exitCode: 0, stdout: "ok", stderr: "" },
      checks,
      threads,
      changedPaths: ["src/x.ts"],
      protectedPaths: [],
    };
    const saved = buildReviewReceipt(input);
    const current = { number: 12, head: HEAD, checks, changedPaths: ["src/x.ts"] };
    assert.equal(receiptMatchesCurrent(saved, current, threads, []), true);
    assert.equal(
      receiptMatchesCurrent(
        saved,
        { ...current, checks: [{ ...checks[0]!, conclusion: "FAILURE" }] },
        threads,
        [],
      ),
      false,
    );
    assert.equal(
      receiptMatchesCurrent(saved, current, [{ ...threads[0]!, resolved: true }], []),
      false,
    );
  });
});
