/**
 * Pillar 2 §4.4 — fleet-RBAC distribution. RBAC is carried in the signed `.kit-policy.toml`
 * (`[rbac]` table, extracted by rbac/resolve.loadVerifiedPolicy), so `kit policy pull` ALREADY
 * distributes role→permission mappings "verified as policy, no new runtime". These tests LOCK that
 * end-to-end guarantee: a pulled policy's bindings take effect, and a tampered `[rbac]` table is
 * rejected (fail-closed) exactly like any other policy change.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, identityId } from "./identity.js";
import { resolveKeyStore } from "./keystore/index.js";
import {
  loadPolicy,
  canonicalPolicyBytes,
  policyFingerprint,
  getPolicyPath,
  getPolicySigPath,
  type PolicySignature,
} from "./policy-doc.js";
import { addPolicySigner } from "./policy-trust.js";
import { pullPolicy } from "./policy-pull.js";
import { loadVerifiedPolicy, effectivePermissions, can } from "./rbac/resolve.js";

let idDir: string;
let source: string;
let dest: string;
let savedId: string | undefined;

const SUBJECT = "kid_subject_example";

const RBAC_POLICY = `version = 1

[rbac.roles]
deployer = ["deploy:prod"]
reader = ["read:*"]

[[rbac.bindings]]
kid = "${SUBJECT}"
role = "deployer"
`;

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
  source = mkdtempSync(join(tmpdir(), "kit-rbac-src-"));
  dest = mkdtempSync(join(tmpdir(), "kit-rbac-dest-"));
  savedId = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity();
});

afterEach(() => {
  if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedId;
  for (const d of [idDir, source, dest]) rmSync(d, { recursive: true, force: true });
});

describe("fleet-RBAC distributes via kit policy pull (Pillar 2 §4.4)", () => {
  it("a pulled policy's [rbac] bindings take effect", () => {
    writeFileSync(getPolicyPath(source), RBAC_POLICY, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org");

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, true, r.detail);

    const vp = loadVerifiedPolicy(dest);
    assert.ok(vp, "pulled policy must load + verify at the destination");
    assert.deepEqual(effectivePermissions(SUBJECT, vp), ["deploy:prod"]);
    assert.equal(can(SUBJECT, "deploy:prod", vp), true);
    assert.equal(can(SUBJECT, "deploy:staging", vp), false, "not granted → deny");
    assert.equal(can("kid_stranger", "deploy:prod", vp), false, "unbound subject → deny");
  });

  it("a tampered [rbac] table is rejected — not applied (fail-closed)", () => {
    writeFileSync(getPolicyPath(source), RBAC_POLICY, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org");
    // Escalate the grant AFTER signing → canonical bytes change → signature no longer matches.
    writeFileSync(getPolicyPath(source), RBAC_POLICY.replace('["deploy:prod"]', '["*"]'), "utf-8");

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, false);
    assert.equal(r.status, "invalid");
    assert.equal(existsSync(getPolicyPath(dest)), false, "must not apply a tampered RBAC policy");
    assert.equal(loadVerifiedPolicy(dest), null);
  });
});
