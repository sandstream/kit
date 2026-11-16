import assert from "node:assert/strict";
import { it } from "node:test";
import { decideIncomingExecution } from "./decision.js";
import { decisionFixture } from "./decision.test-support.js";
import type { IncomingContext } from "./decision.js";

const decide = (f: ReturnType<typeof decisionFixture>) =>
  decideIncomingExecution(f.context, f.verification, f.approval, f.authority, f.now);

it("permits the exact current candidate with complete checks and an independent signature", () => {
  const f = decisionFixture();
  assert.deepEqual(decide(f), { allowed: true, reason: "accepted" });
});

for (const field of [
  "repositoryId",
  "baselineDigest",
  "candidateDigest",
  "policyDigest",
  "generation",
] as const) {
  it(`refuses a signed approval for another ${field}`, () => {
    const f = decisionFixture();
    const value = field === "generation" ? 4 : field === "repositoryId" ? "repo-2" : "f".repeat(64);
    f.context = { ...f.context, [field]: value };
    assert.equal(decide(f).allowed, false);
  });
}

it("refuses a report for another candidate even when the report is signed", () => {
  const f = decisionFixture();
  f.verification.context.candidateDigest = "a".repeat(64);
  f.resign();
  assert.deepEqual(decide(f), { allowed: false, reason: "verification-mismatch" });
});

it("refuses changed evidence behind a valid old approval", () => {
  const f = decisionFixture();
  f.verification.checks[0].evidenceDigest = "a".repeat(64);
  assert.deepEqual(decide(f), { allowed: false, reason: "approval-mismatch" });
});

it("refuses signatures made by candidate-controlled keys", () => {
  const f = decisionFixture();
  const attacker = decisionFixture();
  f.approval = attacker.approval;
  assert.deepEqual(decide(f), { allowed: false, reason: "untrusted-signer" });
});

it("refuses a candidate signature labelled with the trusted signer id", () => {
  const f = decisionFixture();
  const attacker = decisionFixture();
  attacker.approval.signerId = f.authority.signers[0].id;
  attacker.resign();
  f.approval = attacker.approval;
  assert.deepEqual(decide(f), { allowed: false, reason: "invalid-signature" });
});

it("refuses an approval after its signer is removed from external authority", () => {
  const f = decisionFixture();
  f.authority.signers = decisionFixture().authority.signers;
  assert.deepEqual(decide(f), { allowed: false, reason: "untrusted-signer" });
});

for (const status of ["fail", "skipped"] as const) {
  it(`refuses a signed report with a ${status} check`, () => {
    const f = decisionFixture();
    f.verification.checks[0].status = status;
    f.resign();
    assert.deepEqual(decide(f), { allowed: false, reason: "checks-incomplete" });
  });
}

it("refuses omitted and duplicated checks even with a valid approval", () => {
  const f = decisionFixture();
  f.verification.checks.pop();
  f.resign();
  assert.deepEqual(decide(f), { allowed: false, reason: "checks-incomplete" });
  f.verification.checks.push({ ...f.verification.checks[0] });
  f.resign();
  assert.deepEqual(decide(f), { allowed: false, reason: "checks-incomplete" });
});

it("uses externally required checks even when a candidate proposes fewer checks", () => {
  const f = decisionFixture();
  f.authority.requiredChecks.push("new-check");
  assert.deepEqual(decide(f), { allowed: false, reason: "checks-incomplete" });
});

it("does not authorize a modified context merely because it is copied into every report", () => {
  const f = decisionFixture();
  const changed: IncomingContext = { ...f.context, generation: f.context.generation + 1 };
  f.context = changed;
  f.verification.context = changed;
  f.approval.context = changed;
  f.resign();
  assert.deepEqual(decide(f), { allowed: false, reason: "authority-mismatch" });
});

it("returns fixed reasons without returning input data", () => {
  const f = decisionFixture();
  f.approval.signature = "private-input-do-not-echo";
  assert.deepEqual(decide(f), { allowed: false, reason: "invalid-approval" });
});
