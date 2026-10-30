import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureReviewSnapshot,
  writeReviewReceipt,
  type ReadCommand,
} from "./review-receipt-io.js";

const gate = { command: "kit review --receipt", exitCode: 0, stdout: "ok", stderr: "" };
const BASE = "b".repeat(40);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-snapshot-"));
  const root = join(dir, "repo");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "user.name", "Test");
  writeFileSync(
    join(root, ".gitignore"),
    ".kit-review-receipt.json\n.kit-review-receipt-history.jsonl\n",
  );
  writeFileSync(join(root, "file.txt"), "first\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  const state = { base: BASE, baseName: "main", remote: git(root, "rev-parse", "HEAD").trim() };
  const run: ReadCommand = (command, args) => {
    if (command === "git") return git(root, ...args);
    const call = [command, ...args].join(" ");
    if (call === "gh repo view --json nameWithOwner") return '{"nameWithOwner":"example/project"}';
    if (call.startsWith("gh pr view --json"))
      return JSON.stringify({
        number: 1,
        headRefOid: state.remote,
        changedFiles: 1,
        files: [{ path: "file.txt" }],
        statusCheckRollup: [],
      });
    if (call.startsWith("gh api graphql ") && call.includes("baseRefName baseRef")) {
      return JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "main", target: { oid: BASE } },
            pullRequest: {
              number: 1,
              headRefOid: state.remote,
              baseRefName: state.baseName,
              baseRef: { target: { oid: state.base } },
            },
          },
        },
      });
    }
    throw new Error(`unexpected command ${call}`);
  };
  return { dir, root, state, run };
}

describe("receipt identity is captured before review", () => {
  for (const change of ["commit", "base", "dirty"] as const) {
    it(`refuses a ${change} change while the review runs`, async () => {
      const { dir, root, state, run } = setup();
      try {
        const snapshot = captureReviewSnapshot(root, run);
        // These changes stand in for activity while the review stages are running.
        if (change === "commit") {
          writeFileSync(join(root, "file.txt"), "second\n");
          git(root, "add", "file.txt");
          git(root, "commit", "-qm", "second");
          state.remote = git(root, "rev-parse", "HEAD").trim();
        } else if (change === "base") {
          state.baseName = "other";
          state.base = "c".repeat(40);
        } else {
          writeFileSync(join(root, "file.txt"), "dirty\n");
        }
        await assert.rejects(writeReviewReceipt(root, gate, run, snapshot), /changed|clean/i);
        assert.equal(existsSync(join(root, ".kit-review-receipt.json")), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
