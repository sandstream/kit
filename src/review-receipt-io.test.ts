import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReviewReceipt,
  captureReviewSnapshot,
  readFailedReviewRuns,
  verifyReviewReceiptFile,
  writeReviewReceipt,
  type ReadCommand,
} from "./review-receipt-io.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const RULES = JSON.stringify({
  release: { exact: [], prefix: [] },
  github: { exact: [], prefix: [".github/"] },
  secrets: { exact: [], prefix: ["src/secrets"] },
  permissions: { exact: [], prefix: [] },
});
const root = process.cwd();
const gate = {
  command: "kit review --receipt --enforce",
  exitCode: 0,
  stdout: '{"ok":true}\n',
  stderr: "",
};

interface FakeOptions {
  dirty?: boolean;
  remoteHead?: string;
  rootDir?: string;
  weaken?: boolean;
  baseMoves?: boolean;
  baseName?: string;
  baseNameMoves?: boolean;
  missingBase?: boolean;
}

function fakeFiles(weaken?: boolean) {
  return weaken
    ? [
        { filename: ".github/kit-protected-paths.json", status: "modified" },
        { filename: "src/secrets-rotate.ts", status: "modified" },
      ]
    : [{ filename: ".github/workflows/ci.yml", status: "modified" }];
}

function fakeRefs(options: FakeOptions, refsCalls: number): string {
  return JSON.stringify({
    data: {
      repository: {
        defaultBranchRef: { name: "main", target: { oid: BASE } },
        pullRequest: {
          number: 12,
          headRefOid: options.remoteHead ?? HEAD,
          baseRefName:
            options.baseNameMoves && refsCalls > 1 ? "other" : (options.baseName ?? "main"),
          baseRef: { target: { oid: options.baseMoves && refsCalls > 1 ? "c".repeat(40) : BASE } },
        },
      },
    },
  });
}

function fakeView(options: FakeOptions): string {
  return JSON.stringify({
    number: 12,
    headRefOid: options.remoteHead ?? HEAD,
    changedFiles: fakeFiles(options.weaken).length,
    files: fakeFiles(options.weaken).map((file) => ({ path: file.filename })),
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
}

function fakeRuleSnapshot(options: FakeOptions): string {
  const weakened = JSON.stringify({
    release: { exact: [], prefix: [] },
    github: { exact: [], prefix: [] },
    secrets: { exact: [], prefix: [] },
    permissions: { exact: [], prefix: [] },
  });
  const rule = options.missingBase ? null : { __typename: "Blob", text: RULES, isTruncated: false };
  return JSON.stringify({
    data: {
      repository: {
        baseCommit: { oid: BASE },
        headCommit: { oid: HEAD },
        defaultCommit: { oid: BASE },
        defaultFile: rule,
        baseFile: rule,
        headFile: {
          __typename: "Blob",
          text: options.weaken ? weakened : RULES,
          isTruncated: false,
        },
      },
    },
  });
}

function fakeGitCommand(call: string, options: FakeOptions): string | null {
  if (call === "git rev-parse --show-toplevel") return (options.rootDir ?? root) + "\n";
  if (call === "git rev-parse HEAD") return HEAD + "\n";
  if (call.startsWith("git ls-files -z -- ")) return "";
  if (call === "git status --porcelain --untracked-files=all")
    return options.dirty ? " M src/x.ts\n" : "";
  return null;
}

function fakeCommands(options: FakeOptions = {}): ReadCommand {
  let refsCalls = 0;
  return (command, args) => {
    const call = [command, ...args].join(" ");
    const gitResult = fakeGitCommand(call, options);
    if (gitResult !== null) return gitResult;
    if (call === "gh repo view --json nameWithOwner") return '{"nameWithOwner":"sandstream/kit"}';
    if (call.startsWith("gh api --paginate --slurp repos/sandstream/kit/pulls/12/files"))
      return JSON.stringify([fakeFiles(options.weaken)]);
    if (call.startsWith("gh api graphql ") && call.includes("baseRefName baseRef"))
      return fakeRefs(options, ++refsCalls);
    if (call.startsWith("gh pr view --json ")) return fakeView(options);
    if (call.startsWith("gh api graphql ") && call.includes("baseCommit:object"))
      return fakeRuleSnapshot(options);
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

  it("keeps base protections when the PR removes them", () => {
    const receipt = collectReviewReceipt(root, gate, fakeCommands({ weaken: true }));
    assert.deepEqual(receipt.protected_paths, [
      { path: ".github/kit-protected-paths.json", classes: ["github"] },
      { path: "src/secrets-rotate.ts", classes: ["secrets"] },
    ]);
  });

  it("uses built-in defaults when the base has no rule file, and refuses a changing base", () => {
    assert.deepEqual(
      collectReviewReceipt(root, gate, fakeCommands({ missingBase: true })).protected_paths,
      [{ path: ".github/workflows/ci.yml", classes: ["github"] }],
    );
    assert.throws(
      () => collectReviewReceipt(root, gate, fakeCommands({ baseMoves: true })),
      /base or head changed/i,
    );
    assert.throws(
      () => collectReviewReceipt(root, gate, fakeCommands({ baseNameMoves: true })),
      /base or head changed/i,
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
        captureReviewSnapshot(dir, run),
      );
      await writeReviewReceipt(
        dir,
        { ...gate, command: "kit review --receipt", exitCode: 1, stdout: "second" },
        run,
        captureReviewSnapshot(dir, run),
      );
      assert.equal(await readFailedReviewRuns(dir, HEAD, "kit review --receipt"), 2);
      assert.equal((await verifyReviewReceiptFile(dir, undefined, run)).ok, true);
    } finally {
      if (previous === undefined) delete process.env.KIT_AUDIT_ANCHOR_DIR;
      else process.env.KIT_AUDIT_ANCHOR_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a signed receipt when the base branch changes with the same head", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-review-receipt-base-"));
    const previous = process.env.KIT_AUDIT_ANCHOR_DIR;
    process.env.KIT_AUDIT_ANCHOR_DIR = join(dir, "anchor");
    try {
      const run = fakeCommands({ rootDir: dir });
      await writeReviewReceipt(dir, gate, run, captureReviewSnapshot(dir, run));
      assert.equal(
        (await verifyReviewReceiptFile(dir, undefined, fakeCommands({ rootDir: dir }))).ok,
        true,
      );
      assert.match(
        (
          await verifyReviewReceiptFile(
            dir,
            undefined,
            fakeCommands({ rootDir: dir, baseName: "other" }),
          )
        ).reason,
        /base or head/i,
      );
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
