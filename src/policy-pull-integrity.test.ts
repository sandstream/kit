/**
 * PP-01 and PP-02: the two ways `kit policy pull` could install a policy the operator
 * did not consent to.
 *
 * PP-01 (verify-then-reread): the pulled pair is staged in a temp dir and verified
 * THERE, but the install then read the SOURCE again. A source that changes between
 * those two moments (a shared mount, a git checkout, an attacker with write access to
 * the distribution dir) got its post-verification bytes installed under a "verified"
 * verdict. The window is not theoretical: it spans the whole `verifyPolicy` call.
 * `afterVerify` makes that window observable so this is a deterministic test, not a race.
 *
 * PP-02 (revision ratchet): PolicyDoc.revision is documented as a one-way ratchet
 * ("kit refuses to apply a distributed bundle whose revision is lower"), which closes
 * the replay attack of re-serving an older, still-validly-signed policy to restore a
 * permission the org has since removed. Nothing enforced it.
 */

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
import { addPolicySigner } from "./policy-trust.js";
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

/** The template plus an explicit revision, and optionally a distinguishing marker key. */
function policyText(revision?: number, marker?: string): string {
  let text = POLICY_TEMPLATE;
  if (marker !== undefined) text += `\nx_marker = "${marker}"\n`;
  if (revision !== undefined) text += `\nrevision = ${revision}\n`;
  return text;
}

/** Write + sign a policy into `dir`. */
function publish(dir: string, revision?: number, marker?: string): string {
  writeFileSync(getPolicyPath(dir), policyText(revision, marker), "utf-8");
  return signPolicyInDir(dir);
}

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  source = mkdtempSync(join(tmpdir(), "kit-pull-int-src-"));
  dest = mkdtempSync(join(tmpdir(), "kit-pull-int-dest-"));
  savedId = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity();
});

afterEach(() => {
  if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedId;
  for (const d of [idDir, source, dest]) rmSync(d, { recursive: true, force: true });
});

describe("pullPolicy installs the bytes it verified (PP-01)", () => {
  it("a source swapped after verification does not reach disk", () => {
    const pub = publish(source, undefined, "verified");
    addPolicySigner(dest, pub, "org");
    const verifiedPolicy = readFileSync(getPolicyPath(source));
    const verifiedSignature = readFileSync(getPolicySigPath(source));

    // The swap is a DIFFERENT policy, validly signed by the same trusted signer: it
    // would verify on its own, so nothing but "install what you verified" catches it.
    const r = pullPolicy(source, dest, {
      afterVerify: () => publish(source, undefined, "swapped"),
    });

    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(
      readFileSync(getPolicyPath(dest)),
      verifiedPolicy,
      "the installed policy must be the bytes that were verified in THIS run",
    );
    assert.deepEqual(readFileSync(getPolicySigPath(dest)), verifiedSignature);
    assert.doesNotMatch(readFileSync(getPolicyPath(dest), "utf-8"), /swapped/);
  });

  it("ok: true implies the on-disk pair verifies, even when only the policy is swapped", () => {
    const pub = publish(source, undefined, "verified");
    addPolicySigner(dest, pub, "org");

    // Swap the policy but leave the signature: the pair on the source is now
    // self-inconsistent, so re-reading it installs a pair that cannot verify.
    const r = pullPolicy(source, dest, {
      afterVerify: () => {
        writeFileSync(getPolicyPath(source), policyText(undefined, "swapped"), "utf-8");
      },
    });

    assert.equal(r.ok, true, r.detail);
    assert.equal(
      verifyPolicy(dest).status,
      "valid",
      "a successful pull must never leave a pair that fails verification",
    );
  });
});

/** Put a signed, verifying policy at `revision` in place as the APPLIED policy. */
function applied(revision?: number): void {
  const pub = publish(dest, revision, "applied");
  addPolicySigner(dest, pub, "org");
  assert.equal(verifyPolicy(dest).status, "valid");
}

describe("pullPolicy refuses a backward revision (PP-02)", () => {
  it("refuses a lower incoming revision and keeps the applied pair", () => {
    applied(5);
    const policyBefore = readFileSync(getPolicyPath(dest));
    const signatureBefore = readFileSync(getPolicySigPath(dest));
    publish(source, 1, "rollback");

    const r = pullPolicy(source, dest);

    assert.equal(r.ok, false, r.detail);
    assert.equal(r.status, "stale-revision");
    assert.match(r.detail, /revision/);
    assert.deepEqual(readFileSync(getPolicyPath(dest)), policyBefore);
    assert.deepEqual(readFileSync(getPolicySigPath(dest)), signatureBefore);
  });

  it("refuses an incoming policy with NO revision once a revision is applied", () => {
    applied(5);
    const policyBefore = readFileSync(getPolicyPath(dest));
    publish(source, undefined, "unversioned");

    const r = pullPolicy(source, dest);

    assert.equal(r.ok, false, r.detail);
    assert.equal(r.status, "stale-revision");
    assert.deepEqual(readFileSync(getPolicyPath(dest)), policyBefore);
  });
});

describe("pullPolicy still applies every non-rollback revision (PP-02)", () => {
  it("applies a higher incoming revision", () => {
    applied(5);
    publish(source, 6, "next");

    const r = pullPolicy(source, dest);

    assert.equal(r.ok, true, r.detail);
    assert.equal(r.status, "applied");
    assert.equal(loadPolicy(dest)!.revision, 6);
    assert.equal(verifyPolicy(dest).status, "valid");
  });

  it("applies an equal revision: a re-apply is not a rollback", () => {
    applied(5);
    publish(source, 5, "same-revision-new-content");

    const r = pullPolicy(source, dest);

    assert.equal(r.ok, true, r.detail);
    assert.match(readFileSync(getPolicyPath(dest), "utf-8"), /same-revision-new-content/);
  });

  it("stays backward compatible: no applied revision means no ratchet yet", () => {
    applied(undefined);
    publish(source, undefined, "also-unversioned");

    const r = pullPolicy(source, dest);

    assert.equal(r.ok, true, r.detail);
    assert.equal(r.status, "applied");
  });

  it("ratchets from the first revision: unversioned applied, versioned incoming applies", () => {
    applied(undefined);
    publish(source, 3, "first-revision");

    const r = pullPolicy(source, dest);

    assert.equal(r.ok, true, r.detail);
    assert.equal(loadPolicy(dest)!.revision, 3);
  });

  it("applies to a destination with no policy at all", () => {
    const pub = publish(source, 2, "fresh");
    addPolicySigner(dest, pub, "org");
    assert.equal(existsSync(getPolicyPath(dest)), false);

    const r = pullPolicy(source, dest);

    assert.equal(r.ok, true, r.detail);
    assert.equal(loadPolicy(dest)!.revision, 2);
  });
});
