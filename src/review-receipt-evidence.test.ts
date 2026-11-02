import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rmTemp } from "./temp-cleanup.test-support.js";
import {
  assertReviewSnapshot,
  captureReviewSnapshot,
  type ReadCommand,
} from "./review-receipt-evidence.js";

const BASE = "b".repeat(40);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-evidence-"));
  const root = join(dir, "repo");
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  git("config", "core.hooksPath", join(dir, "no-hooks"));
  writeFileSync(join(root, "tracked.txt"), "original\n");
  git("add", "tracked.txt");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "initial");
  const state = {
    head: git("rev-parse", "HEAD").trim(),
    repo: "example/project",
    base: BASE,
    baseName: "main",
    malformedRefs: false,
  };
  const run: ReadCommand = (command, args, cwd) => {
    if (command === "git") return execFileSync(command, args, { cwd, encoding: "utf8" });
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: state.repo });
    if (args[0] === "pr")
      return JSON.stringify({
        number: 1,
        headRefOid: state.head,
        changedFiles: 1,
        files: [{ path: "tracked.txt" }],
        statusCheckRollup: [],
      });
    if (args[0] === "api") {
      if (state.malformedRefs) return JSON.stringify({ data: { repository: null } });
      return JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "main", target: { oid: BASE } },
            pullRequest: {
              number: 1,
              headRefOid: state.head,
              baseRefName: state.baseName,
              baseRef: { target: { oid: state.base } },
            },
          },
        },
      });
    }
    throw new Error(`unexpected command ${command} ${args[0]}`);
  };
  return { dir, root, state, run };
}

describe("review evidence snapshot", () => {
  it("captures and checks the exact local and remote identities", () => {
    const { dir, root, state, run } = setup();
    try {
      const snapshot = captureReviewSnapshot(root, run);
      assert.equal(snapshot.head, state.head);
      assert.equal(snapshot.repo, state.repo);
      assert.equal(snapshot.refs.base, BASE);
      assert.doesNotThrow(() => assertReviewSnapshot(snapshot, run));
    } finally {
      rmTemp(dir);
    }
  });

  it("rejects a pull request head that does not match the local commit", () => {
    const { dir, root, state, run } = setup();
    try {
      state.head = "c".repeat(40);
      assert.throws(() => captureReviewSnapshot(root, run), /head changed before review/);
    } finally {
      rmTemp(dir);
    }
  });

  it("rejects a changed repository after snapshot capture", () => {
    const { dir, root, state, run } = setup();
    try {
      const snapshot = captureReviewSnapshot(root, run);
      state.repo = "other/project";
      assert.throws(() => assertReviewSnapshot(snapshot, run), /pull request changed/);
    } finally {
      rmTemp(dir);
    }
  });

  it("rejects malformed GitHub branch evidence", () => {
    const { dir, root, state, run } = setup();
    try {
      state.malformedRefs = true;
      assert.throws(() => captureReviewSnapshot(root, run), /invalid GitHub repository/);
    } finally {
      rmTemp(dir);
    }
  });
});
