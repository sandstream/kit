import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAuditAnchorKey } from "./audit-anchor.js";
import { buildReviewReceipt, signReviewReceipt } from "./review-receipt.js";
import { verifyReviewReceiptFile } from "./review-receipt-verify.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import type { ReadCommand } from "./review-receipt-evidence.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-verify-"));
  const root = join(dir, "repo");
  const anchor = join(dir, "anchor");
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "core.hooksPath", join(dir, "no-hooks"));
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  );
  const head = git("rev-parse", "HEAD").trim();
  const state = { base: head };
  const run: ReadCommand = (command, args, cwd) => {
    if (command === "git") return execFileSync(command, args, { cwd, encoding: "utf8" });
    if (args[0] === "repo") return '{"nameWithOwner":"example/project"}';
    if (args[0] === "pr")
      return JSON.stringify({
        number: 1,
        headRefOid: head,
        changedFiles: 0,
        files: [],
        statusCheckRollup: [],
      });
    if (args[0] === "api")
      return JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "main", target: { oid: head } },
            pullRequest: {
              number: 1,
              headRefOid: head,
              baseRefName: "main",
              baseRef: { target: { oid: state.base } },
            },
          },
        },
      });
    throw new Error(`unexpected command ${command} ${args[0]}`);
  };
  const input = {
    repo: "example/project",
    pr: 1,
    localHead: head,
    remoteHead: head,
    baseBranch: "main",
    baseHead: head,
    policyBranch: "main",
    policyHead: head,
    createdAt: "2026-11-01T00:00:00.000Z",
    gate: { command: "kit review --receipt", exitCode: 0, stdout: "ok", stderr: "" },
    checks: [],
    threads: [],
    changedPaths: [],
    protectedPaths: [],
  };
  return { dir, root, anchor, input, state, run };
}

async function withFixture(
  test: (value: ReturnType<typeof setup>) => Promise<void>,
): Promise<void> {
  const fixture = setup();
  const previous = process.env.KIT_AUDIT_ANCHOR_DIR;
  process.env.KIT_AUDIT_ANCHOR_DIR = fixture.anchor;
  try {
    await test(fixture);
  } finally {
    if (previous === undefined) delete process.env.KIT_AUDIT_ANCHOR_DIR;
    else process.env.KIT_AUDIT_ANCHOR_DIR = previous;
    rmTemp(fixture.dir);
  }
}

describe("review receipt verification", () => {
  it("accepts a signed receipt bound to the current PR and branch heads", async () => {
    await withFixture(async ({ root, input, run }) => {
      const signed = signReviewReceipt(buildReviewReceipt(input), await getAuditAnchorKey());
      writeFileSync(join(root, ".kit-review-receipt.json"), JSON.stringify(signed));
      const result = await verifyReviewReceiptFile(root, undefined, run);
      assert.equal(result.ok, true);
      assert.equal(result.receipt?.head, input.localHead);
    });
  });

  it("rejects a changed signature", async () => {
    await withFixture(async ({ root, input, run }) => {
      const signed = signReviewReceipt(buildReviewReceipt(input), await getAuditAnchorKey());
      signed.signature = Buffer.alloc(32, 9).toString("base64");
      writeFileSync(join(root, ".kit-review-receipt.json"), JSON.stringify(signed));
      const result = await verifyReviewReceiptFile(root, undefined, run);
      assert.equal(result.ok, false);
      assert.match(result.reason, /signature is invalid/);
    });
  });

  it("rejects a receipt when the signing key is missing without creating one", async () => {
    await withFixture(async ({ root, anchor, input, run }) => {
      const signed = signReviewReceipt(buildReviewReceipt(input), Buffer.alloc(32, 7));
      writeFileSync(join(root, ".kit-review-receipt.json"), JSON.stringify(signed));
      const result = await verifyReviewReceiptFile(root, undefined, run);
      assert.equal(result.ok, false);
      assert.match(result.reason, /signing key is unavailable/);
      assert.equal(existsSync(join(anchor, "audit-anchor.key")), false);
    });
  });

  it("rejects an interrupted review", async () => {
    await withFixture(async ({ root, input, run }) => {
      const receipt = buildReviewReceipt({ ...input, runStatus: "interrupted" });
      writeFileSync(
        join(root, ".kit-review-receipt.json"),
        JSON.stringify(signReviewReceipt(receipt, await getAuditAnchorKey())),
      );
      const result = await verifyReviewReceiptFile(root, undefined, run);
      assert.equal(result.ok, false);
      assert.match(result.reason, /review was interrupted/);
    });
  });

  it("rejects a failed review whose signed history is missing", async () => {
    await withFixture(async ({ root, input, run }) => {
      const receipt = buildReviewReceipt({ ...input, gate: { ...input.gate, exitCode: 1 } });
      writeFileSync(
        join(root, ".kit-review-receipt.json"),
        JSON.stringify(signReviewReceipt(receipt, await getAuditAnchorKey())),
      );
      const result = await verifyReviewReceiptFile(root, undefined, run);
      assert.equal(result.ok, false);
      assert.match(result.reason, /failed review is missing from signed history/);
    });
  });

  it("rejects a changed base commit", async () => {
    await withFixture(async ({ root, input, state, run }) => {
      const signed = signReviewReceipt(buildReviewReceipt(input), await getAuditAnchorKey());
      writeFileSync(join(root, ".kit-review-receipt.json"), JSON.stringify(signed));
      state.base = "c".repeat(40);
      const result = await verifyReviewReceiptFile(root, undefined, run);
      assert.equal(result.ok, false);
      assert.match(result.reason, /current PR base or head/);
    });
  });
});
