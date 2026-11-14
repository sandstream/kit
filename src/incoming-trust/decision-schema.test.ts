import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { it } from "node:test";
import { decideIncomingExecution } from "./decision.js";
import { decisionFixture } from "./decision.test-support.js";
import type { IncomingDenial } from "./decision.js";

type Fixture = ReturnType<typeof decisionFixture>;
function expectRefusal(f: Fixture, reason: IncomingDenial): void {
  assert.deepEqual(
    decideIncomingExecution(f.context, f.verification, f.approval, f.authority, f.now),
    { allowed: false, reason },
  );
}

for (const [name, mutate, reason] of [
  [
    "future verification",
    (f: Fixture) => {
      f.verification.createdAt = f.now + 1;
    },
    "stale-verification",
  ],
  [
    "verification expiry boundary",
    (f: Fixture) => {
      f.verification.createdAt = f.now - f.authority.maxVerificationAgeMs;
    },
    "stale-verification",
  ],
  [
    "future approval",
    (f: Fixture) => {
      f.approval.issuedAt = f.now + 1;
    },
    "stale-approval",
  ],
  [
    "approval expiry boundary",
    (f: Fixture) => {
      f.approval.expiresAt = f.now;
    },
    "stale-approval",
  ],
  [
    "approval predates verification",
    (f: Fixture) => {
      f.approval.issuedAt = f.verification.createdAt - 1;
    },
    "stale-approval",
  ],
  [
    "approval exceeds external lifetime",
    (f: Fixture) => {
      f.approval.expiresAt = f.approval.issuedAt + f.authority.maxApprovalAgeMs + 1;
    },
    "stale-approval",
  ],
  [
    "zero approval lifetime",
    (f: Fixture) => {
      f.approval.expiresAt = f.approval.issuedAt;
    },
    "stale-approval",
  ],
] as const) {
  it(`refuses ${name} with a cryptographically valid signature`, () => {
    const f = decisionFixture();
    mutate(f);
    f.resign();
    expectRefusal(f, reason);
  });
}

it("permits evidence and approval immediately inside their time boundaries", () => {
  const f = decisionFixture();
  f.verification.createdAt = f.now - f.authority.maxVerificationAgeMs + 1;
  f.approval.issuedAt = f.now;
  f.approval.expiresAt = f.now + f.authority.maxApprovalAgeMs;
  f.resign();
  assert.equal(
    decideIncomingExecution(f.context, f.verification, f.approval, f.authority, f.now).allowed,
    true,
  );
});

for (const now of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  it(`refuses an invalid clock value (${now})`, () => {
    const f = decisionFixture();
    f.now = now;
    expectRefusal(f, "invalid-time");
  });
}

for (const value of [undefined, null]) {
  it(`refuses absent authority, approval, and verification (${value})`, () => {
    const f = decisionFixture();
    assert.deepEqual(decideIncomingExecution(f.context, f.verification, f.approval, value, f.now), {
      allowed: false,
      reason: "missing-authority",
    });
    assert.deepEqual(decideIncomingExecution(f.context, value, f.approval, f.authority, f.now), {
      allowed: false,
      reason: "missing-verification",
    });
    assert.deepEqual(
      decideIncomingExecution(f.context, f.verification, value, f.authority, f.now),
      { allowed: false, reason: "missing-approval" },
    );
  });
}

for (const value of [[], 1, true, "data", {}, { schema: 2 }]) {
  it(`refuses malformed protocol documents (${JSON.stringify(value)})`, () => {
    const f = decisionFixture();
    assert.deepEqual(
      decideIncomingExecution(value, f.verification, f.approval, f.authority, f.now),
      { allowed: false, reason: "invalid-context" },
    );
    assert.deepEqual(decideIncomingExecution(f.context, value, f.approval, f.authority, f.now), {
      allowed: false,
      reason: "invalid-verification",
    });
    assert.deepEqual(
      decideIncomingExecution(f.context, f.verification, value, f.authority, f.now),
      { allowed: false, reason: "invalid-approval" },
    );
    assert.deepEqual(decideIncomingExecution(f.context, f.verification, f.approval, value, f.now), {
      allowed: false,
      reason: "invalid-authority",
    });
  });
}

it("refuses schema changes and unsigned extra fields on otherwise valid documents", () => {
  const f = decisionFixture();
  for (const update of [{ schema: 2 }, { unchecked: "candidate metadata" }]) {
    assert.equal(
      decideIncomingExecution(
        { ...f.context, ...update },
        f.verification,
        f.approval,
        f.authority,
        f.now,
      ).allowed,
      false,
    );
    assert.equal(
      decideIncomingExecution(
        f.context,
        { ...f.verification, ...update },
        f.approval,
        f.authority,
        f.now,
      ).allowed,
      false,
    );
    assert.equal(
      decideIncomingExecution(
        f.context,
        f.verification,
        { ...f.approval, ...update },
        f.authority,
        f.now,
      ).allowed,
      false,
    );
    assert.equal(
      decideIncomingExecution(
        f.context,
        f.verification,
        f.approval,
        { ...f.authority, ...update },
        f.now,
      ).allowed,
      false,
    );
  }
});

for (const [name, mutate] of [
  [
    "empty policy",
    (f: Fixture) => {
      f.authority.requiredChecks = [];
    },
  ],
  [
    "duplicate policy check",
    (f: Fixture) => {
      f.authority.requiredChecks.push("inventory");
    },
  ],
  [
    "empty signer list",
    (f: Fixture) => {
      f.authority.signers = [];
    },
  ],
  [
    "duplicate signer",
    (f: Fixture) => {
      f.authority.signers.push({ ...f.authority.signers[0] });
    },
  ],
  [
    "signer fingerprint mismatch",
    (f: Fixture) => {
      f.authority.signers[0].id = "f".repeat(64);
    },
  ],
  [
    "invalid public key",
    (f: Fixture) => {
      f.authority.signers[0].publicKeyPem =
        "-----BEGIN PUBLIC KEY-----\nbroken\n-----END PUBLIC KEY-----";
    },
  ],
  [
    "zero verification lifetime",
    (f: Fixture) => {
      f.authority.maxVerificationAgeMs = 0;
    },
  ],
  [
    "invalid generation",
    (f: Fixture) => {
      f.authority.generation = 0.5;
    },
  ],
] as const) {
  it(`refuses ${name}`, () => {
    const f = decisionFixture();
    mutate(f);
    expectRefusal(f, "invalid-authority");
  });
}

it("does not accept a different signature algorithm in external authority", () => {
  const f = decisionFixture();
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  f.authority.signers = [
    {
      id: createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  ];
  expectRefusal(f, "invalid-authority");
});

it("refuses changed signature bytes and changed signed expiry", () => {
  const f = decisionFixture();
  const signature = Buffer.from(f.approval.signature, "base64");
  signature[0] ^= 1;
  f.approval.signature = signature.toString("base64");
  expectRefusal(f, "invalid-signature");
  f.resign();
  f.approval.expiresAt += 1;
  expectRefusal(f, "invalid-signature");
});

it("refuses a signature that is valid base64 with a noncanonical encoding", () => {
  const f = decisionFixture();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const index = alphabet.indexOf(f.approval.signature[85]);
  f.approval.signature = f.approval.signature.slice(0, 85) + alphabet[index + 1] + "==";
  expectRefusal(f, "invalid-approval");
});

it("refuses coerced check statuses instead of treating arrays as strings", () => {
  const f = decisionFixture();
  const verification = {
    ...f.verification,
    checks: [{ ...f.verification.checks[0], status: ["pass"] }],
  };
  assert.deepEqual(
    decideIncomingExecution(f.context, verification, f.approval, f.authority, f.now),
    { allowed: false, reason: "invalid-verification" },
  );
});

it("permits frozen JSON documents without changing their data", () => {
  const f = decisionFixture();
  for (const check of f.verification.checks) Object.freeze(check);
  Object.freeze(f.verification.checks);
  for (const doc of [f.context, f.verification, f.approval, f.authority]) Object.freeze(doc);
  const before = JSON.stringify(f);
  assert.equal(
    decideIncomingExecution(f.context, f.verification, f.approval, f.authority, f.now).allowed,
    true,
  );
  assert.equal(JSON.stringify(f), before);
});
