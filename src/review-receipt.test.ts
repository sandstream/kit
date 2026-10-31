import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewReceipt, signReviewReceipt, verifyReviewReceipt } from "./review-receipt.js";

const HEAD = "a".repeat(40);
const KEY = Buffer.alloc(32, 7);

const input = () => ({
  repo: "sandstream/kit",
  pr: 647,
  localHead: HEAD,
  remoteHead: HEAD,
  baseBranch: "main",
  baseHead: "b".repeat(40),
  policyBranch: "main",
  policyHead: "b".repeat(40),
  createdAt: "2026-10-29T08:00:00.000Z",
  gate: {
    command: "kit review --json --enforce",
    exitCode: 0,
    stdout: '{"ok":true}',
    stderr: "",
    failures: [] as string[],
  },
  checks: [
    {
      name: "build-and-test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      url: "https://example.test/check",
    },
  ],
  threads: [
    {
      id: "thread-1",
      path: "src/x.ts",
      line: 12,
      resolved: false,
      resolvedBy: null,
      comments: [{ url: "https://example.test/comment", body: "Fix this unsafe case" }],
    },
  ],
  changedPaths: ["src/x.ts"],
  protectedPaths: [],
});

describe("review receipt", () => {
  it("binds the gate, checks, and review threads to one head commit", () => {
    const receipt = buildReviewReceipt(input());
    assert.equal(receipt.head, HEAD);
    assert.equal(receipt.gate.exit_code, 0);
    assert.match(receipt.gate.output_sha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.checks[0]?.conclusion, "SUCCESS");
    assert.equal(receipt.review_threads[0]?.status, "open");
    assert.deepEqual(receipt.evidence_issues, ["unresolved GitHub review threads exist"]);
    assert.match(receipt.review_threads[0]?.comments[0]?.body_sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(receipt).includes("Fix this unsafe case"));
  });

  it("refuses a PR head that differs from the local commit", () => {
    assert.throws(() => buildReviewReceipt({ ...input(), remoteHead: "b".repeat(40) }), /head/i);
  });

  it("marks missing and pending CI evidence as incomplete", () => {
    assert.deepEqual(buildReviewReceipt({ ...input(), checks: [] }).evidence_issues, [
      "no CI checks were returned",
      "unresolved GitHub review threads exist",
    ]);
    const pending = input();
    pending.checks[0]!.conclusion = "";
    assert.match(buildReviewReceipt(pending).evidence_issues[0] ?? "", /CI check/);
  });

  it("detects changes to the signed verdict and checks", () => {
    const signed = signReviewReceipt(buildReviewReceipt(input()), KEY);
    assert.equal(verifyReviewReceipt(signed, KEY, HEAD).ok, true);
    assert.equal(verifyReviewReceipt(signed, KEY, "b".repeat(40)).ok, false);
    const changed = structuredClone(signed);
    changed.checks[0]!.conclusion = "FAILURE";
    assert.equal(verifyReviewReceipt(changed, KEY, HEAD).ok, false);
    assert.equal(verifyReviewReceipt({ ...signed, signature: "bad" }, KEY, HEAD).ok, false);
  });

  it("records failing checks with the gate output", () => {
    const failed = input();
    failed.gate.exitCode = 1;
    failed.gate.failures = ["standards: complexity in src/x.ts"];
    const receipt = buildReviewReceipt(failed);
    assert.deepEqual(receipt.gate.failures, ["standards: complexity in src/x.ts"]);
  });
});
