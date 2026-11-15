import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptCandidate,
  rejectCandidate,
  requestApproval,
  retryCandidate,
  stageCandidate,
} from "./lifecycle.js";
import { storeFixture } from "./authority-store.test-support.js";
import type { IncomingCheck } from "./decision.js";
import type { IncomingApprovalRequest } from "./lifecycle.js";

const DIGEST = "c".repeat(64);

function passingChecks(f: ReturnType<typeof storeFixture>): IncomingCheck[] {
  return f.proof.authority.requiredChecks.map((id) => ({
    id,
    status: "pass" as const,
    evidenceDigest: "e".repeat(64),
  }));
}

/** The fixture re-signs its own report object, so copy the requested report into it. */
function signRequest(f: ReturnType<typeof storeFixture>, request: IncomingApprovalRequest) {
  Object.assign(f.proof.verification, structuredClone(request.verification));
  f.proof.approval.context = { ...request.verification.context };
  f.proof.resign();
  return f.proof.approval;
}

function enrolled() {
  const f = storeFixture();
  try {
    f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    return f;
  } catch (error) {
    f.cleanup();
    throw error;
  }
}

describe("incoming approval lifecycle: stage and request", () => {
  it("stages a candidate and builds a verification the authority can sign", () => {
    const f = enrolled();
    try {
      const staged = stageCandidate(f.store, f.repository, DIGEST, []);
      assert.equal(staged.candidateDigest, DIGEST);
      const request = requestApproval(f.store, f.repository, passingChecks(f), f.proof.now);
      assert.equal(request.verification.context.candidateDigest, DIGEST);
      assert.equal(request.verification.context.generation, staged.authority.generation);
      assert.equal(request.verification.createdAt, f.proof.now);
      assert.match(request.verificationDigest, /^[a-f0-9]{64}$/);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a request before any candidate is staged", () => {
    const f = enrolled();
    try {
      assert.throws(
        () => requestApproval(f.store, f.repository, passingChecks(f), f.proof.now),
        /no-candidate/,
      );
    } finally {
      f.cleanup();
    }
  });

  it("refuses a request whose checks can never satisfy the authority", () => {
    const f = enrolled();
    try {
      stageCandidate(f.store, f.repository, DIGEST, []);
      const checks = passingChecks(f);
      checks.pop();
      assert.throws(
        () => requestApproval(f.store, f.repository, checks, f.proof.now),
        /checks-incomplete/,
      );
      checks.push({ id: "scanners", status: "fail", evidenceDigest: "e".repeat(64) });
      assert.throws(
        () => requestApproval(f.store, f.repository, checks, f.proof.now),
        /checks-incomplete/,
      );
    } finally {
      f.cleanup();
    }
  });

  it("refuses a repository that was never enrolled", () => {
    const f = storeFixture();
    try {
      assert.throws(() => stageCandidate(f.store, f.repository, DIGEST, []), /not-enrolled/);
    } finally {
      f.cleanup();
    }
  });
});

describe("incoming approval lifecycle: decide", () => {
  it("accepts a signed approval for the requested verification and allows only that digest", () => {
    const f = enrolled();
    try {
      stageCandidate(f.store, f.repository, DIGEST, []);
      const request = requestApproval(f.store, f.repository, passingChecks(f), f.proof.now - 2_000);
      const approval = signRequest(f, request);
      assert.equal(approval.verificationDigest, request.verificationDigest);
      const accepted = acceptCandidate(
        f.store,
        f.repository,
        request.verification,
        approval,
        f.proof.now,
      );
      assert.equal(accepted.phase, "accepted");
      assert.deepEqual(f.store.decide(f.repository, DIGEST, f.proof.now), {
        allowed: true,
        reason: "accepted",
      });
      assert.deepEqual(f.store.decide(f.repository, "d".repeat(64), f.proof.now), {
        allowed: false,
        reason: "candidate-mismatch",
      });
    } finally {
      f.cleanup();
    }
  });

  it("refuses a forged approval and leaves the state pending", () => {
    const f = enrolled();
    try {
      stageCandidate(f.store, f.repository, DIGEST, []);
      const request = requestApproval(f.store, f.repository, passingChecks(f), f.proof.now - 2_000);
      const approval = signRequest(f, request);
      approval.signature = Buffer.alloc(64, 1).toString("base64");
      assert.throws(
        () => acceptCandidate(f.store, f.repository, request.verification, approval, f.proof.now),
        /invalid-signature/,
      );
      assert.equal(f.store.read(f.repository)?.phase, "pending");
    } finally {
      f.cleanup();
    }
  });

  it("rejects, blocks a repeated stage, and needs a retry before a new request", () => {
    const f = enrolled();
    try {
      stageCandidate(f.store, f.repository, DIGEST, []);
      const rejected = rejectCandidate(f.store, f.repository);
      assert.equal(rejected.phase, "rejected");
      assert.equal(stageCandidate(f.store, f.repository, DIGEST, []).phase, "rejected");
      assert.throws(
        () => requestApproval(f.store, f.repository, passingChecks(f), f.proof.now),
        /not-pending/,
      );
      const retried = retryCandidate(f.store, f.repository);
      assert.equal(retried.phase, "pending");
      assert.equal(retried.authority.generation, rejected.authority.generation + 1);
      assert.throws(() => retryCandidate(f.store, f.repository), /not-rejected/);
    } finally {
      f.cleanup();
    }
  });
});
