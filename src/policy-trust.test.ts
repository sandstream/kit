import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { identityId } from "./identity.js";
import {
  canonicalPolicyBytes,
  policyFingerprint,
  verifyPolicy,
  getPolicyPath,
  getPolicySigPath,
} from "./policy-doc.js";
import {
  addPolicySigner,
  loadPolicySigners,
  removePolicySigner,
  hasPolicyAnchor,
} from "./policy-trust.js";
import { evaluatePolicy } from "./policy-check.js";

function orgKey(): { priv: KeyObject; pubPem: string; id: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  return { priv: privateKey, pubPem, id: identityId(pubPem) };
}

function writeSignedPolicy(
  root: string,
  doc: Record<string, unknown>,
  key: { priv: KeyObject; pubPem: string; id: string },
): void {
  // Serialize the doc as TOML matching the object we sign (so fingerprints align).
  const toml = Object.entries(doc)
    .map(([k, v]) => `${k} = ${typeof v === "string" ? `"${v}"` : v}`)
    .join("\n");
  writeFileSync(getPolicyPath(root), toml + "\n");
  const sig = edSign(null, Buffer.from(canonicalPolicyBytes(doc)), key.priv).toString("base64");
  writeFileSync(
    getPolicySigPath(root),
    JSON.stringify({ kid: key.id, sig, ts: "t", fingerprint: policyFingerprint(doc) }),
  );
}

describe("policy-trust — the org trust anchor", () => {
  // Point identity at an EMPTY dir so localPublicKeys() is empty — forcing
  // resolution to fall through to the committed .kit-policy.signers anchor.
  let idDir: string;
  const prev = process.env.KIT_IDENTITY_DIR;
  before(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-trust-id-"));
    process.env.KIT_IDENTITY_DIR = idDir;
  });
  after(() => {
    if (prev === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prev;
    rmSync(idDir, { recursive: true, force: true });
  });

  it("add/load/dedupe/remove roundtrip; malformed key throws", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-trust-"));
    try {
      const k = orgKey();
      assert.equal(hasPolicyAnchor(root), false);
      const added = addPolicySigner(root, k.pubPem, "acme-sec");
      assert.equal(added.added, true);
      assert.equal(added.signer.id, k.id);
      assert.equal(loadPolicySigners(root).length, 1);
      assert.equal(hasPolicyAnchor(root), true);
      // idempotent
      assert.equal(addPolicySigner(root, k.pubPem).added, false);
      // remove
      assert.equal(removePolicySigner(root, k.id), true);
      assert.equal(hasPolicyAnchor(root), false);
      // malformed
      assert.throws(() => addPolicySigner(root, "not a key"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies an ORG-signed policy via the anchor (not the local identity)", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-trust-v-"));
    try {
      const org = orgKey();
      writeSignedPolicy(root, { version: 1, require_triage: true }, org);
      // No anchor yet, and the signer is not a local key → unverifiable.
      const before = verifyPolicy(root);
      assert.equal(before.status, "unverifiable");
      assert.equal(before.anchored, false);
      // Trust the org key → now it verifies, sourced from the org anchor.
      addPolicySigner(root, org.pubPem, "acme-sec");
      const after = verifyPolicy(root);
      assert.equal(after.status, "valid", after.detail);
      assert.equal(after.via, "org");
      assert.equal(after.anchored, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fail-CLOSED: once an anchor exists, a signer not in it fails the gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-trust-fc-"));
    try {
      const signer = orgKey();
      const otherTrusted = orgKey();
      writeSignedPolicy(root, { version: 1, require_triage: true }, signer);
      // Anchor contains a DIFFERENT org key, not the one that signed.
      addPolicySigner(root, otherTrusted.pubPem, "someone-else");
      const v = verifyPolicy(root);
      assert.equal(v.status, "unverifiable");
      assert.equal(v.anchored, true);
      // evaluatePolicy turns that into a hard fail (not a warn) because an anchor exists.
      const report = await evaluatePolicy(root);
      assert.equal(report.signature?.status, "fail", JSON.stringify(report.signature));
      assert.equal(report.ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
