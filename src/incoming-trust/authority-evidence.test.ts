import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptCandidate, requestApproval, stageCandidate } from "./lifecycle.js";
import { storeFixture } from "./authority-store.test-support.js";
import type { IncomingCheck } from "./decision.js";
import type { IncomingApprovalRequest } from "./lifecycle.js";

const DIGEST = "c".repeat(64);
const KIT_DIGEST = "a".repeat(64);

function setup() {
  const f = storeFixture();
  try {
    f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const [kitCheck] = f.proof.authority.requiredChecks;
    const evidence: IncomingCheck[] = [
      { id: kitCheck, status: "pass", evidenceDigest: KIT_DIGEST },
    ];
    stageCandidate(f.store, f.repository, DIGEST, evidence);
    const all = (digestOf: string): IncomingCheck[] =>
      f.proof.authority.requiredChecks.map((id) => ({
        id,
        status: "pass" as const,
        evidenceDigest: id === kitCheck ? digestOf : "e".repeat(64),
      }));
    return { f, kitCheck, all };
  } catch (error) {
    f.cleanup();
    throw error;
  }
}

function sign(f: ReturnType<typeof storeFixture>, request: IncomingApprovalRequest) {
  Object.assign(f.proof.verification, structuredClone(request.verification));
  f.proof.approval.context = { ...request.verification.context };
  f.proof.resign();
  return f.proof.approval;
}

describe("operator checks are bound to the evidence kit computed at stage", () => {
  it("builds a request when the supplied checks carry kit's own digest", () => {
    const { f, all } = setup();
    try {
      const request = requestApproval(f.store, f.repository, all(KIT_DIGEST), f.proof.now - 2_000);
      const accepted = acceptCandidate(
        f.store,
        f.repository,
        request.verification,
        sign(f, request),
        f.proof.now,
      );
      assert.equal(accepted.phase, "accepted");
    } finally {
      f.cleanup();
    }
  });

  it("refuses a request that claims another digest for a check kit computed", () => {
    const { f, all } = setup();
    try {
      assert.throws(
        () => requestApproval(f.store, f.repository, all("b".repeat(64)), f.proof.now),
        /evidence-mismatch/,
      );
    } finally {
      f.cleanup();
    }
  });

  it("refuses a request that leaves out a check kit computed", () => {
    const { f, all, kitCheck } = setup();
    try {
      const without = all(KIT_DIGEST).filter((check) => check.id !== kitCheck);
      assert.throws(
        () => requestApproval(f.store, f.repository, without, f.proof.now),
        /evidence-mismatch|checks-incomplete/,
      );
    } finally {
      f.cleanup();
    }
  });

  it("refuses to accept a signed report whose check differs from kit's evidence", () => {
    const { f, all } = setup();
    try {
      const request = requestApproval(f.store, f.repository, all(KIT_DIGEST), f.proof.now - 2_000);
      const forged = structuredClone(request);
      forged.verification.checks[0].evidenceDigest = "b".repeat(64);
      assert.throws(
        () =>
          acceptCandidate(f.store, f.repository, forged.verification, sign(f, forged), f.proof.now),
        /evidence-mismatch/,
      );
      assert.equal(f.store.read(f.repository)?.phase, "pending");
    } finally {
      f.cleanup();
    }
  });
});
