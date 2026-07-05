import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateIdentity,
  signWithIdentity,
  recordRevocation,
  loadRevocations,
  type RevocationRecord,
} from "../identity.js";
import {
  loadPolicy,
  policyFingerprint,
  canonicalPolicyBytes,
  getPolicyPath,
} from "../policy-doc.js";
import { addPolicySigner } from "../policy-trust.js";
import {
  verifyPolicyBundle,
  applyPolicyBundle,
  fetchPolicyBundle,
  isPolicyBundle,
  type PolicyBundle,
} from "./distribute.js";

const POLICY_TOML = "version = 1\n";

/** Build an org-signed bundle: sign POLICY_TOML with `signerDir`'s identity. */
function signBundle(signerDir: string, revocations?: RevocationRecord[]): PolicyBundle {
  const authorDir = mkdtempSync(join(tmpdir(), "kit-cp-author-"));
  try {
    writeFileSync(getPolicyPath(authorDir), POLICY_TOML, "utf-8");
    const doc = loadPolicy(authorDir)!;
    const { identity } = loadOrCreateIdentity(signerDir);
    const sig = signWithIdentity(canonicalPolicyBytes(doc), signerDir).toString("base64");
    const policySig = JSON.stringify({
      kid: identity.id,
      sig,
      ts: "2026-07-04T00:00:00.000Z",
      fingerprint: policyFingerprint(doc),
    });
    return { policyToml: POLICY_TOML, policySig, revocations };
  } finally {
    rmSync(authorDir, { recursive: true, force: true });
  }
}

/** Build an org-signed bundle for arbitrary policy TOML (used for the revision ratchet). */
function signBundleToml(signerDir: string, policyToml: string): PolicyBundle {
  const authorDir = mkdtempSync(join(tmpdir(), "kit-cp-author-"));
  try {
    writeFileSync(getPolicyPath(authorDir), policyToml, "utf-8");
    const doc = loadPolicy(authorDir)!;
    const { identity } = loadOrCreateIdentity(signerDir);
    const sig = signWithIdentity(canonicalPolicyBytes(doc), signerDir).toString("base64");
    const policySig = JSON.stringify({
      kid: identity.id,
      sig,
      ts: "2026-07-04T00:00:00.000Z",
      fingerprint: policyFingerprint(doc),
    });
    return { policyToml, policySig };
  } finally {
    rmSync(authorDir, { recursive: true, force: true });
  }
}

describe("control-plane — verifyPolicyBundle (offline, against the org anchor)", () => {
  let signerDir: string;
  let verifierKit: string;
  let root: string;
  let signerId: string;
  const prevKit = process.env.KIT_IDENTITY_DIR;

  before(() => {
    signerDir = mkdtempSync(join(tmpdir(), "kit-cp-signer-"));
    const { identity } = loadOrCreateIdentity(signerDir);
    signerId = identity.id;
    // Verifier machine identity is EMPTY → signer resolves via the ORG anchor,
    // not "local" — the real fresh-clone distribution scenario.
    verifierKit = mkdtempSync(join(tmpdir(), "kit-cp-vkit-"));
    process.env.KIT_IDENTITY_DIR = verifierKit;
    root = mkdtempSync(join(tmpdir(), "kit-cp-root-"));
    addPolicySigner(root, identity.publicKey, "org-security"); // writes .kit-policy.signers
  });

  after(() => {
    if (prevKit === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prevKit;
    for (const d of [signerDir, verifierKit, root]) rmSync(d, { recursive: true, force: true });
  });

  it("accepts a bundle signed by a trusted org signer", () => {
    const r = verifyPolicyBundle(signBundle(signerDir), root);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.policy.status, "valid");
    assert.equal(r.verifiedRevocations.length, 0);
  });

  it("verifies attached revocations signed by a trusted signer", () => {
    const rev = recordRevocation("kid_target", "compromised", signerDir);
    const r = verifyPolicyBundle(signBundle(signerDir, [rev]), root);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.verifiedRevocations.length, 1);
    assert.equal(r.verifiedRevocations[0].kid, "kid_target");
  });

  it("rejects a tampered policy (fingerprint/signature mismatch)", () => {
    const bundle = signBundle(signerDir);
    bundle.policyToml = "version = 2\n"; // changed after signing
    const r = verifyPolicyBundle(bundle, root);
    assert.equal(r.ok, false);
    assert.equal(r.policy.status, "invalid");
  });

  it("rejects a signer NOT in the org anchor (fail-closed on trust-absence)", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "kit-cp-noanchor-"));
    try {
      const r = verifyPolicyBundle(signBundle(signerDir), emptyRoot);
      assert.equal(r.ok, false);
      assert.equal(r.policy.status, "unverifiable");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("rejects a bundle signed by the LOCAL machine key when it is NOT in the org anchor (no local-trust bypass)", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "kit-cp-machine-"));
    const prev = process.env.KIT_IDENTITY_DIR;
    try {
      loadOrCreateIdentity(machineDir); // this machine's own identity
      process.env.KIT_IDENTITY_DIR = machineDir; // localPublicKeys() now knows it
      // Signed by the machine key, but `root`'s anchor trusts only the org signer.
      const r = verifyPolicyBundle(signBundle(machineDir), root);
      assert.equal(r.ok, false, "a self-signed bundle must not verify as org-valid");
      assert.equal(r.policy.status, "unverifiable");
    } finally {
      process.env.KIT_IDENTITY_DIR = prev; // back to the empty verifier identity
      rmSync(machineDir, { recursive: true, force: true });
    }
  });

  it("rejects a revocation signed by an UNTRUSTED key", () => {
    const attackerDir = mkdtempSync(join(tmpdir(), "kit-cp-attacker-"));
    try {
      loadOrCreateIdentity(attackerDir);
      const rogue = recordRevocation("kid_victim", "evil", attackerDir); // by = attacker, not anchored
      const r = verifyPolicyBundle(signBundle(signerDir, [rogue]), root);
      assert.equal(r.ok, false);
      assert.match(r.reason ?? "", /not in the org trust anchor/);
    } finally {
      rmSync(attackerDir, { recursive: true, force: true });
    }
  });

  it("rejects a revocation with a tampered signature", () => {
    const rev = recordRevocation("kid_target", "compromised", signerDir);
    const tampered = { ...rev, reason: "changed-after-signing" }; // sig no longer covers reason
    const r = verifyPolicyBundle(signBundle(signerDir, [tampered]), root);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /invalid signature/);
  });

  it("references the signer id in the verified policy", () => {
    const r = verifyPolicyBundle(signBundle(signerDir), root);
    assert.equal(r.policy.kid, signerId);
  });
});

describe("control-plane — applyPolicyBundle (write-after-verify, fail-closed)", () => {
  let signerDir: string;
  let verifierKit: string;
  let root: string;
  let mergeDir: string;
  const prevKit = process.env.KIT_IDENTITY_DIR;

  before(() => {
    signerDir = mkdtempSync(join(tmpdir(), "kit-cp2-signer-"));
    const { identity } = loadOrCreateIdentity(signerDir);
    verifierKit = mkdtempSync(join(tmpdir(), "kit-cp2-vkit-"));
    process.env.KIT_IDENTITY_DIR = verifierKit;
    root = mkdtempSync(join(tmpdir(), "kit-cp2-root-"));
    mergeDir = mkdtempSync(join(tmpdir(), "kit-cp2-merge-"));
    addPolicySigner(root, identity.publicKey);
  });

  after(() => {
    if (prevKit === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prevKit;
    for (const d of [signerDir, verifierKit, root, mergeDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("applies a valid bundle: writes policy + sig, merges revocations, idempotently", () => {
    const rev = recordRevocation("kid_target", "compromised", signerDir);
    const bundle = signBundle(signerDir, [rev]);
    const r = applyPolicyBundle(bundle, root, { identityDir: mergeDir });
    assert.equal(r.applied, true, r.reason);
    assert.equal(r.revocationsAdded, 1);
    assert.equal(readFileSync(getPolicyPath(root), "utf-8"), POLICY_TOML);
    assert.ok(existsSync(join(root, ".kit-policy.sig")));
    assert.equal(loadRevocations(mergeDir).length, 1);

    // Re-apply: policy re-written, revocation dedup → 0 added.
    const again = applyPolicyBundle(bundle, root, { identityDir: mergeDir });
    assert.equal(again.applied, true);
    assert.equal(again.revocationsAdded, 0);
    assert.equal(loadRevocations(mergeDir).length, 1);
  });

  it("enforces the monotonic revision ratchet (rejects a signed rollback)", () => {
    const rroot = mkdtempSync(join(tmpdir(), "kit-cp2-rev-"));
    const rmerge = mkdtempSync(join(tmpdir(), "kit-cp2-revm-"));
    try {
      addPolicySigner(rroot, loadOrCreateIdentity(signerDir).identity.publicKey);
      // apply revision 5
      assert.equal(
        applyPolicyBundle(signBundleToml(signerDir, "version = 1\nrevision = 5\n"), rroot, {
          identityDir: rmerge,
        }).applied,
        true,
      );
      // a validly-signed OLDER revision (3) is refused — the replay/rollback attack
      const rollback = applyPolicyBundle(
        signBundleToml(signerDir, "version = 1\nrevision = 3\n"),
        rroot,
        {
          identityDir: rmerge,
        },
      );
      assert.equal(rollback.applied, false);
      assert.match(rollback.reason ?? "", /rollback/);
      assert.match(loadPolicy(rroot)!.revision + "", /5/); // on-disk policy unchanged
      // a validly-signed bundle with NO revision is also refused once a revision is set
      assert.equal(
        applyPolicyBundle(signBundleToml(signerDir, "version = 1\n"), rroot, {
          identityDir: rmerge,
        }).applied,
        false,
      );
      // a strictly-greater revision (6) advances
      assert.equal(
        applyPolicyBundle(signBundleToml(signerDir, "version = 1\nrevision = 6\n"), rroot, {
          identityDir: rmerge,
        }).applied,
        true,
      );
      assert.equal(loadPolicy(rroot)!.revision, 6);
      // idempotent re-apply of the SAME (revision 6) bundle is allowed
      assert.equal(
        applyPolicyBundle(signBundleToml(signerDir, "version = 1\nrevision = 6\n"), rroot, {
          identityDir: rmerge,
        }).applied,
        true,
      );
    } finally {
      rmSync(rroot, { recursive: true, force: true });
      rmSync(rmerge, { recursive: true, force: true });
    }
  });

  it("an unsigned planted high revision does not freeze legitimate updates", () => {
    const rroot = mkdtempSync(join(tmpdir(), "kit-cp2-f2-"));
    const rmerge = mkdtempSync(join(tmpdir(), "kit-cp2-f2m-"));
    try {
      addPolicySigner(rroot, loadOrCreateIdentity(signerDir).identity.publicKey);
      applyPolicyBundle(signBundleToml(signerDir, "version = 1\nrevision = 5\n"), rroot, {
        identityDir: rmerge,
      });
      // attacker with local write plants an UNSIGNED high revision (sig still matches rev 5)
      writeFileSync(getPolicyPath(rroot), "version = 1\nrevision = 999999\n", "utf-8");
      // the on-disk policy no longer verifies → its revision is NOT a trusted floor → a
      // legitimate org-signed rev 6 still applies (no fail-closed DoS on updates)
      const r = applyPolicyBundle(signBundleToml(signerDir, "version = 1\nrevision = 6\n"), rroot, {
        identityDir: rmerge,
      });
      assert.equal(r.applied, true, r.reason);
      assert.equal(loadPolicy(rroot)!.revision, 6);
    } finally {
      rmSync(rroot, { recursive: true, force: true });
      rmSync(rmerge, { recursive: true, force: true });
    }
  });

  it("refuses to apply an unverifiable bundle and leaves root untouched", () => {
    const cleanRoot = mkdtempSync(join(tmpdir(), "kit-cp2-clean-"));
    try {
      addPolicySigner(cleanRoot, loadOrCreateIdentity(signerDir).identity.publicKey);
      const bundle = signBundle(signerDir);
      bundle.policySig = JSON.stringify({ kid: "kid_x", sig: "AA==", ts: "t", fingerprint: "x" });
      const r = applyPolicyBundle(bundle, cleanRoot, { identityDir: mergeDir });
      assert.equal(r.applied, false);
      assert.equal(existsSync(getPolicyPath(cleanRoot)), false, "policy not written on failure");
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });
});

describe("control-plane — fetchPolicyBundle (file offline + injectable http)", () => {
  it("reads a bundle from a local file path (air-gapped, no network)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-cp-fetch-"));
    try {
      const path = join(dir, "bundle.json");
      const bundle: PolicyBundle = { policyToml: "version = 1\n", policySig: "{}" };
      writeFileSync(path, JSON.stringify(bundle));
      const got = await fetchPolicyBundle(path);
      assert.deepEqual(got, bundle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetches over https via an injectable fetch; fail-closed on non-OK", async () => {
    const bundle: PolicyBundle = { policyToml: "version = 1\n", policySig: "{}" };
    const okFetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(bundle),
    })) as unknown as typeof fetch;
    assert.deepEqual(
      await fetchPolicyBundle("https://cp.example/bundle", { fetchImpl: okFetch }),
      bundle,
    );

    const badFetch = (async () => ({
      ok: false,
      status: 503,
      text: async () => "",
    })) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchPolicyBundle("https://cp.example/bundle", { fetchImpl: badFetch }),
      /HTTP 503/,
    );
  });

  it("rejects malformed JSON and a wrong-shaped bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-cp-fetch2-"));
    try {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ not json");
      await assert.rejects(() => fetchPolicyBundle(bad), /not valid JSON/);
      const wrong = join(dir, "wrong.json");
      writeFileSync(wrong, JSON.stringify({ nope: true }));
      await assert.rejects(() => fetchPolicyBundle(wrong), /malformed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isPolicyBundle guards shape", () => {
    assert.equal(isPolicyBundle({ policyToml: "x", policySig: "y" }), true);
    assert.equal(isPolicyBundle({ policyToml: "x" }), false);
    assert.equal(isPolicyBundle(null), false);
  });
});
