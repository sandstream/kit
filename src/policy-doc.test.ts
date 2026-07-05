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
      require_hardware_identity: true,
      min_kit_version: "2.2.0",
      thresholds: { code_health: 7.5 },
    });
    assert.equal(r.ok, true, r.errors.join("; "));
  });

  it("type-checks require_hardware_identity as a boolean", () => {
    assert.match(
      validatePolicy({ version: 1, require_hardware_identity: "yes" }).errors.join(),
      /require_hardware_identity.*boolean/,
    );
    assert.equal(validatePolicy({ version: 1, require_hardware_identity: true }).ok, true);
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

  // sortDeep used `out[k] = …`, so a `__proto__` key was a prototype write that
  // silently dropped the key+subtree — an attacker could append a `[__proto__]`
  // table to a SIGNED policy without changing its signing bytes. The canonical
  // form must now cover every own key faithfully.
  it("does not silently drop a `__proto__` key from the signing bytes", () => {
    const benign = { version: 1, require_triage: true };
    // JSON.parse yields an OWN enumerable `__proto__` property (like smol-toml does
    // for a `[__proto__]` table) — distinct from the `{__proto__: …}` literal.
    const smuggled = JSON.parse(
      '{"version":1,"require_triage":true,"__proto__":{"require_triage":false}}',
    );
    assert.notEqual(
      canonicalPolicyBytes(benign),
      canonicalPolicyBytes(smuggled),
      "a smuggled __proto__ table must change the signing bytes",
    );
    assert.match(canonicalPolicyBytes(smuggled), /__proto__/);
    // and no global prototype pollution as a side effect
    assert.equal(({} as Record<string, unknown>).require_triage, undefined);
  });

  it("refuses a date value (no faithful canonical form → Date≡string collision)", () => {
    assert.throws(
      () => canonicalPolicyBytes({ version: 1, min_kit_version: new Date("2020-01-01") }),
      /date/i,
    );
  });

  it("validatePolicy rejects prototype-manipulating keys", () => {
    const doc = JSON.parse('{"version":1,"__proto__":{"x":1}}');
    assert.match(validatePolicy(doc).errors.join(), /forbidden key/);
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
