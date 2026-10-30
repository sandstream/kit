import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPrEvidence, receiptMatchesCurrent } from "./escalate-pr-io.js";
import type { ReadCommand } from "./review-receipt-io.js";
import { buildReviewReceipt } from "./review-receipt.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const RULES = JSON.stringify({
  release: { exact: [], prefix: [] },
  github: { exact: [], prefix: [".github/"] },
  secrets: { exact: [], prefix: ["src/secrets"] },
  permissions: { exact: [], prefix: [] },
});

function fakePrView(remoteHead: string, weaken = false): string {
  return JSON.stringify({
    number: 12,
    headRefOid: remoteHead,
    changedFiles: weaken ? 2 : 1,
    files: weaken
      ? [{ path: ".github/kit-protected-paths.json" }, { path: "src/secrets-rotate.ts" }]
      : [{ path: ".github/workflows/ci.yml" }],
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
}

function fakeReviewComments(): string {
  const report = {
    schema: "kit-independent-review/v1",
    repository: "sandstream/kit",
    pull_request: 12,
    base_branch: "main",
    base_tip: BASE,
    base: BASE,
    head: HEAD,
    verdict: "pass",
    checks: ["correctness", "security", "tests", "public-hygiene", "adr"].map((area) => ({
      area,
      status: "pass",
      evidence: "Checked",
    })),
    limits: [],
    findings: [],
  };
  return JSON.stringify([
    [
      {
        id: 1,
        html_url: "https://github.com/sandstream/kit/pull/12#issuecomment-1",
        user: { login: "reviewer", type: "User" },
        author_association: "MEMBER",
        created_at: "2026-10-29T12:00:00Z",
        updated_at: "2026-10-29T12:00:00Z",
        body: `<!-- kit-independent-review:v1 -->\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
      },
    ],
  ]);
}

function fakeGraphql(remoteHead: string, baseQuery: boolean): string {
  const pullRequest = baseQuery
    ? {
        number: 12,
        headRefOid: remoteHead,
        baseRefName: "main",
        baseRef: { target: { oid: BASE } },
      }
    : {
        author: { login: "sandstream" },
        latestOpinionatedReviews: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
        reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
      };
  return JSON.stringify({ data: { repository: { pullRequest } } });
}

interface FakeOptions {
  weaken?: boolean;
  missingBase?: boolean;
  baseMoves?: boolean;
}

function fakeFiles(weaken?: boolean) {
  return weaken
    ? [
        { filename: ".github/kit-protected-paths.json", status: "modified" },
        { filename: "src/secrets-rotate.ts", status: "modified" },
      ]
    : [{ filename: ".github/workflows/ci.yml", status: "modified" }];
}

function fakeRefs(remoteHead: string, options: FakeOptions, refsCalls: number): string {
  return JSON.stringify({
    data: {
      repository: {
        defaultBranchRef: { name: "main", target: { oid: BASE } },
        pullRequest: {
          number: 12,
          headRefOid: remoteHead,
          baseRefName: "main",
          baseRef: { target: { oid: options.baseMoves && refsCalls > 1 ? "c".repeat(40) : BASE } },
        },
      },
    },
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

function fakeCommands(
  root: string,
  remoteHead = HEAD,
  failComments = false,
  options: FakeOptions = {},
): ReadCommand {
  let refsCalls = 0;
  return (command, args) => {
    const call = [command, ...args].join(" ");
    if (call === "git rev-parse --show-toplevel") return root + "\n";
    if (call === "git rev-parse HEAD") return HEAD + "\n";
    if (call === "git status --porcelain --untracked-files=all") return "";
    if (call === "gh repo view --json nameWithOwner") return '{"nameWithOwner":"sandstream/kit"}';
    if (call.startsWith("gh api graphql ") && call.includes("baseRefName baseRef"))
      return fakeRefs(remoteHead, options, ++refsCalls);
    if (call.startsWith("gh pr view --json ")) return fakePrView(remoteHead, options.weaken);
    if (call.startsWith("gh api --paginate --slurp repos/sandstream/kit/pulls/12/files"))
      return JSON.stringify([fakeFiles(options.weaken)]);
    if (call.startsWith("gh api --paginate --slurp ")) {
      if (failComments) throw new Error("GitHub unavailable");
      return fakeReviewComments();
    }
    if (call.startsWith("gh api repos/sandstream/kit/compare/")) return `${BASE}\n`;
    if (call.startsWith("gh api graphql ") && call.includes("baseCommit:object"))
      return fakeRuleSnapshot(options);
    if (call.startsWith("gh api graphql "))
      return fakeGraphql(remoteHead, call.includes("baseRefName baseRef"));
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
      assert.equal(evidence.reviewComments?.[0]?.result.kind, "current");
      assert.deepEqual(evidence.protectedPaths, [
        { path: ".github/workflows/ci.yml", classes: ["github"] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an unavailable comment API instead of hiding it", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-escalate-pr-comments-"));
    try {
      const evidence = await collectPrEvidence(
        root,
        { mergeDenied: false },
        fakeCommands(root, HEAD, true),
      );
      assert.match(evidence.reviewCommentProblem ?? "", /GitHub unavailable/);
      assert.equal(evidence.reviewComments, undefined);
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

describe("collectPrEvidence protection", () => {
  it("retains base protection after a PR weakens the rule file", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-escalate-pr-rules-"));
    try {
      const evidence = await collectPrEvidence(
        root,
        { mergeDenied: false },
        fakeCommands(root, HEAD, false, { weaken: true }),
      );
      assert.deepEqual(evidence.protectedPaths, [
        { path: ".github/kit-protected-paths.json", classes: ["github"] },
        { path: "src/secrets-rotate.ts", classes: ["secrets"] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses built-in defaults for a missing base rule file and refuses a changing base", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-escalate-pr-base-"));
    try {
      const evidence = await collectPrEvidence(
        root,
        { mergeDenied: false },
        fakeCommands(root, HEAD, false, { missingBase: true }),
      );
      assert.deepEqual(evidence.protectedPaths, [
        { path: ".github/workflows/ci.yml", classes: ["github"] },
      ]);
      await assert.rejects(
        collectPrEvidence(
          root,
          { mergeDenied: false },
          fakeCommands(root, HEAD, false, { baseMoves: true }),
        ),
        /base or head changed/i,
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
      baseBranch: "main",
      baseHead: BASE,
      policyBranch: "main",
      policyHead: BASE,
      createdAt: "2026-10-29T10:00:00.000Z",
      gate: { command: "kit review --receipt", exitCode: 0, stdout: "ok", stderr: "" },
      checks,
      threads,
      changedPaths: ["src/x.ts"],
      protectedPaths: [],
    };
    const saved = buildReviewReceipt(input);
    const current = { number: 12, head: HEAD, checks, changedPaths: ["src/x.ts"] };
    const refs = { baseName: "main", base: BASE, defaultName: "main", defaultHead: BASE };
    assert.equal(receiptMatchesCurrent(saved, current, threads, [], refs), true);
    assert.equal(
      receiptMatchesCurrent(saved, current, threads, [], { ...refs, baseName: "other" }),
      false,
    );
    assert.equal(
      receiptMatchesCurrent(saved, current, threads, [], { ...refs, base: HEAD }),
      false,
    );
    assert.equal(
      receiptMatchesCurrent(
        saved,
        { ...current, checks: [{ ...checks[0]!, conclusion: "FAILURE" }] },
        threads,
        [],
        refs,
      ),
      false,
    );
    assert.equal(
      receiptMatchesCurrent(saved, current, [{ ...threads[0]!, resolved: true }], [], refs),
      false,
    );
  });
});
