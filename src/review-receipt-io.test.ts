import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReviewReceipt,
  readFailedReviewRuns,
  verifyReviewReceiptFile,
  writeReviewReceipt,
  type ReadCommand,
} from "./review-receipt-io.js";

const HEAD = "a".repeat(40);
const root = process.cwd();
const gate = {
  command: "kit review --receipt --enforce",
  exitCode: 0,
  stdout: '{"ok":true}\n',
  stderr: "",
};

function fakeCommands(
  options: { dirty?: boolean; remoteHead?: string; rootDir?: string } = {},
): ReadCommand {
  return (command, args) => {
    const call = [command, ...args].join(" ");
    if (call === "git rev-parse --show-toplevel") return (options.rootDir ?? root) + "\n";
    if (call === "git rev-parse HEAD") return HEAD + "\n";
    if (call === "git status --porcelain --untracked-files=all")
      return options.dirty ? " M src/x.ts\n" : "";
    if (call === "gh repo view --json nameWithOwner") return '{"nameWithOwner":"sandstream/kit"}';
    if (call.startsWith("gh pr view --json "))
      return JSON.stringify({
        number: 12,
        headRefOid: options.remoteHead ?? HEAD,
        changedFiles: 1,
        files: [{ path: ".github/workflows/ci.yml" }],
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "CI",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://example.test/ci",
          },
        ],
      });
    if (call.startsWith("gh api graphql "))
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
            },
          },
        },
      });
    throw new Error(`unexpected command: ${call}`);
  };
}

describe("collectReviewReceipt", () => {
  it("collects the exact head, CI checks, and protected paths", () => {
    const receipt = collectReviewReceipt(root, gate, fakeCommands(), "2026-10-29T08:00:00.000Z");
    assert.equal(receipt.head, HEAD);
    assert.equal(receipt.checks[0]?.name, "CI");
    assert.deepEqual(receipt.protected_paths, [
      { path: ".github/workflows/ci.yml", classes: ["github"] },
    ]);
  });

  it("refuses a dirty tree or stale PR head", () => {
    assert.throws(() => collectReviewReceipt(root, gate, fakeCommands({ dirty: true })), /clean/i);
    assert.throws(
      () => collectReviewReceipt(root, gate, fakeCommands({ remoteHead: "b".repeat(40) })),
      /head/i,
    );
  });
});

describe("writeReviewReceipt", () => {
  it("refuses a direct library write in read-only mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-review-receipt-read-only-"));
    const previous = process.env.KIT_READ_ONLY;
    process.env.KIT_READ_ONLY = "1";
    try {
      await assert.rejects(writeReviewReceipt(dir, gate, fakeCommands()), /read-only mode active/);
    } finally {
      if (previous === undefined) delete process.env.KIT_READ_ONLY;
      else process.env.KIT_READ_ONLY = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps two signed failed runs for the same PR head", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-review-receipt-history-"));
    const previous = process.env.KIT_AUDIT_ANCHOR_DIR;
    process.env.KIT_AUDIT_ANCHOR_DIR = join(dir, "anchor");
    const run = fakeCommands({ rootDir: dir });
    try {
      await writeReviewReceipt(
        dir,
        { ...gate, command: "kit review --receipt", exitCode: 1, stdout: "first" },
        run,
      );
      await writeReviewReceipt(
        dir,
        { ...gate, command: "kit review --receipt", exitCode: 1, stdout: "second" },
        run,
      );
      assert.equal(await readFailedReviewRuns(dir, HEAD, "kit review --receipt"), 2);
      assert.equal((await verifyReviewReceiptFile(dir, undefined, run)).ok, true);
    } finally {
      if (previous === undefined) delete process.env.KIT_AUDIT_ANCHOR_DIR;
      else process.env.KIT_AUDIT_ANCHOR_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyReviewReceiptFile", () => {
  it("refuses an oversized receipt before it reads signing keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-review-receipt-large-"));
    const path = join(dir, "receipt.json");
    try {
      writeFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 1));
      const result = await verifyReviewReceiptFile(root, path, fakeCommands());
      assert.deepEqual(result, { ok: false, reason: "review receipt is too large" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
