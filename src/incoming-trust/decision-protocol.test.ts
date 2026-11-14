import assert from "node:assert/strict";
import { sign, verify } from "node:crypto";
import { it } from "node:test";
import { decideIncomingExecution } from "./decision.js";
import { incomingApprovalStatement, incomingVerificationDigest } from "./decision-protocol.js";
import { decisionFixture } from "./decision.test-support.js";

it("matches the frozen verification protocol vector and distinguishes changed evidence", () => {
  const f = decisionFixture();
  // Independently encoded with Python JSON arrays and SHA-256, without this module.
  const expected = "84147cdc36a733eac66108c6427a176749d31cddd9263ff85a8bf5e90830b66f";
  assert.equal(incomingVerificationDigest(f.verification), expected);
  f.verification.checks[0].evidenceDigest = "a".repeat(64);
  assert.notEqual(incomingVerificationDigest(f.verification), expected);
  assert.equal(
    decideIncomingExecution(f.context, f.verification, f.approval, f.authority, f.now).allowed,
    false,
  );
});

it("produces approval bytes compatible with an independent Ed25519 signer", () => {
  const f = decisionFixture();
  const statement = incomingApprovalStatement(f.approval);
  // The fixture signs an independent protocol encoding, not the production helper.
  assert.equal(
    verify(null, statement, f.keys.publicKey, Buffer.from(f.approval.signature, "base64")),
    true,
  );
  f.approval.signature = sign(null, statement, f.keys.privateKey).toString("base64");
  assert.equal(
    decideIncomingExecution(f.context, f.verification, f.approval, f.authority, f.now).allowed,
    true,
  );
  const foreignDomain = Buffer.from(
    statement.toString().replace("kit.incoming-approval", "kit.other-approval"),
  );
  f.approval.signature = sign(null, foreignDomain, f.keys.privateKey).toString("base64");
  assert.deepEqual(
    decideIncomingExecution(f.context, f.verification, f.approval, f.authority, f.now),
    { allowed: false, reason: "invalid-signature" },
  );
});
