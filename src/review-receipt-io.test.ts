import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectReviewReceipt, type ReadCommand } from "./review-receipt-io.js";

const HEAD = "a".repeat(40);
const root = process.cwd();
const gate = { command: "kit review --receipt --enforce", exitCode: 0, stdout: '{"ok":true}\n', stderr: "" };

function fakeCommands(options: { dirty?: boolean; remoteHead?: string } = {}): ReadCommand {
  return (command, args) => {
    const call = [command, ...args].join(" ");
    if (call === "git rev-parse --show-toplevel") return root + "\n";
    if (call === "git rev-parse HEAD") return HEAD + "\n";
    if (call === "git status --porcelain --untracked-files=all") return options.dirty ? " M src/x.ts\n" : "";
    if (call === "gh repo view --json nameWithOwner") return '{"nameWithOwner":"sandstream/kit"}';
    if (call.startsWith("gh pr view --json ")) return JSON.stringify({
      number: 12,
      headRefOid: options.remoteHead ?? HEAD,
      changedFiles: 1,
      files: [{ path: ".github/workflows/ci.yml" }],
      statusCheckRollup: [{ __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.test/ci" }],
    });
    if (call.startsWith("gh api graphql ")) return JSON.stringify({ data: { repository: { pullRequest: {
      reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
    } } } });
    throw new Error(`unexpected command: ${call}`);
  };
}

describe("collectReviewReceipt", () => {
  it("collects the exact head, CI checks, and protected paths", () => {
    const receipt = collectReviewReceipt(root, gate, fakeCommands(), "2026-10-29T08:00:00.000Z");
    assert.equal(receipt.head, HEAD);
    assert.equal(receipt.checks[0]?.name, "CI");
    assert.deepEqual(receipt.protected_paths, [{ path: ".github/workflows/ci.yml", classes: ["github"] }]);
  });

  it("refuses a dirty tree or stale PR head", () => {
    assert.throws(() => collectReviewReceipt(root, gate, fakeCommands({ dirty: true })), /clean/i);
    assert.throws(() => collectReviewReceipt(root, gate, fakeCommands({ remoteHead: "b".repeat(40) })), /head/i);
  });
});
