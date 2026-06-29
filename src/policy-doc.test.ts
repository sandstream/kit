import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validatePolicy,
  canonicalPolicyBytes,
  policyFingerprint,
  POLICY_SCHEMA_VERSION,
} from "./policy-doc.js";
import { loadOrCreateIdentity, signWithIdentity, verifySignature } from "./identity.js";

describe("policy-doc — validation", () => {
  it("accepts a minimal valid policy", () => {
    assert.deepEqual(validatePolicy({ version: 1 }), { ok: true, errors: [] });
  });

  it("accepts the full allow-listed shape", () => {
    const r = validatePolicy({
      version: 1,
      require_triage: true,
      required_scanners: ["trivy", "trufflehog"],
      prod_writes_need_approval: false,
      min_kit_version: "2.2.0",
      thresholds: { code_health: 7.5 },
    });
    assert.equal(r.ok, true, r.errors.join("; "));
  });

  it("flags a missing / non-integer / future version", () => {
    assert.match(validatePolicy({}).errors.join(), /missing required `version`/);
    assert.match(validatePolicy({ version: 1.5 }).errors.join(), /must be an integer/);
    assert.match(
      validatePolicy({ version: POLICY_SCHEMA_VERSION + 1 }).errors.join(),
      /newer than this kit supports/,
    );
  });

  it("type-checks each field", () => {
    assert.match(validatePolicy({ version: 1, require_triage: "yes" }).errors.join(), /boolean/);
    assert.match(
      validatePolicy({ version: 1, required_scanners: "trivy" }).errors.join(),
      /array of strings/,
    );
    assert.match(
      validatePolicy({ version: 1, thresholds: { code_health: "high" } }).errors.join(),
      /thresholds\.code_health.*number/,
    );
  });

  it("rejects a non-table", () => {
    assert.equal(validatePolicy("nope").ok, false);
    assert.equal(validatePolicy(null).ok, false);
  });
});

describe("policy-doc — canonical bytes (stable signing input)", () => {
  it("is independent of key order, at every level", () => {
    const a = { version: 1, require_triage: true, thresholds: { code_health: 7, x: 1 } };
    const b = { thresholds: { x: 1, code_health: 7 }, require_triage: true, version: 1 };
    assert.equal(canonicalPolicyBytes(a), canonicalPolicyBytes(b));
    assert.equal(policyFingerprint(a), policyFingerprint(b));
  });

  it("changes when a value changes", () => {
    assert.notEqual(
      policyFingerprint({ version: 1, require_triage: true }),
      policyFingerprint({ version: 1, require_triage: false }),
    );
  });
});

describe("policy-doc — sign/verify roundtrip over canonical bytes", () => {
  let dir: string;
  const prev = process.env.KIT_IDENTITY_DIR;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-policy-id-"));
    process.env.KIT_IDENTITY_DIR = dir;
  });
  after(() => {
    if (prev === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("verifies a signature over the canonical bytes, and fails on tamper", () => {
    const { identity } = loadOrCreateIdentity();
    const doc = { version: 1, require_triage: true, required_scanners: ["trivy"] };
    const sig = signWithIdentity(canonicalPolicyBytes(doc));
    // valid
    assert.equal(verifySignature(canonicalPolicyBytes(doc), sig, identity.publicKey), true);
    // tampered policy → canonical bytes differ → signature no longer verifies
    const tampered = { ...doc, require_triage: false };
    assert.equal(verifySignature(canonicalPolicyBytes(tampered), sig, identity.publicKey), false);
  });
});
