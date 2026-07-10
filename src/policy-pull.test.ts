import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, identityId } from "./identity.js";
import { resolveKeyStore } from "./keystore/index.js";
import {
  POLICY_TEMPLATE,
  loadPolicy,
  canonicalPolicyBytes,
  policyFingerprint,
  getPolicyPath,
  getPolicySigPath,
  verifyPolicy,
  type PolicySignature,
} from "./policy-doc.js";
import { addPolicySigner, getSignersPath } from "./policy-trust.js";
import { pullPolicy } from "./policy-pull.js";

let idDir: string;
let source: string;
let dest: string;
let savedId: string | undefined;

/** Sign the policy already written in `dir` with the active identity; returns the signer's PEM. */
function signPolicyInDir(dir: string): string {
  const doc = loadPolicy(dir)!;
  const pub = resolveKeyStore().store.publicKeyPem()!;
  const record: PolicySignature = {
    kid: identityId(pub),
    sig: resolveKeyStore().store.sign(canonicalPolicyBytes(doc)).toString("base64"),
    ts: new Date().toISOString(),
    fingerprint: policyFingerprint(doc),
  };
  writeFileSync(getPolicySigPath(dir), JSON.stringify(record, null, 2) + "\n", "utf-8");
  return pub;
}

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  source = mkdtempSync(join(tmpdir(), "kit-pull-src-"));
  dest = mkdtempSync(join(tmpdir(), "kit-pull-dest-"));
  savedId = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity();
});

afterEach(() => {
  if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedId;
  for (const d of [idDir, source, dest]) rmSync(d, { recursive: true, force: true });
});

describe("pullPolicy", () => {
  it("applies a source policy that verifies against the LOCAL anchor", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org"); // local anchor trusts the signer

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.status, "applied");
    assert.ok(existsSync(getPolicyPath(dest)));
    assert.ok(existsSync(getPolicySigPath(dest)));
    // The applied policy verifies in its new home.
    assert.equal(verifyPolicy(dest).status, "valid");
  });

  it("fail-closed (no write) when the source policy was tampered after signing", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org");
    // Tamper AFTER signing → a real content change (a new key, not a comment) so the canonical
    // bytes and thus the fingerprint no longer match the signature.
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE + '\nx_tamper = "evil"\n', "utf-8");

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, false);
    assert.equal(r.status, "invalid");
    assert.equal(existsSync(getPolicyPath(dest)), false, "must not write an unverified policy");
  });

  it("fail-closed 'no-anchor' when the destination has no local trust anchor (root trust is never fetched)", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    signPolicyInDir(source);
    // No addPolicySigner(dest, …) → dest has no .kit-policy.signers.

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, false);
    assert.equal(r.status, "no-anchor");
    assert.equal(existsSync(getPolicyPath(dest)), false);
  });

  it("'no-source' when the source has no signed policy pair", () => {
    addPolicySigner(dest, resolveKeyStore().store.publicKeyPem()!, "org");
    const r = pullPolicy(source, dest);
    assert.equal(r.ok, false);
    assert.equal(r.status, "no-source");
  });

  it("NEVER overwrites the local trust anchor from the source (decision §6.1)", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org");
    const localAnchorBefore = readFileSync(getSignersPath(dest), "utf-8");
    // The source also ships a (different/adversarial) anchor — it must be ignored.
    writeFileSync(getSignersPath(source), JSON.stringify({ signers: [] }) + "\n", "utf-8");

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, true, r.detail);
    assert.equal(
      readFileSync(getSignersPath(dest), "utf-8"),
      localAnchorBefore,
      "the local anchor must be untouched — root trust is never pulled",
    );
  });

  it("resolves a file:// source URI", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org");

    const r = pullPolicy(`file://${source}`, dest);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.status, "applied");
  });
});
