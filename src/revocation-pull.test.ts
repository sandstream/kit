import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateIdentity,
  identityId,
  signWithIdentity,
  revocationStatement,
  isRevoked,
  type RevocationRecord,
} from "./identity.js";
import { resolveKeyStore } from "./keystore/index.js";
import { addPolicySigner } from "./policy-trust.js";
import { REVOCATIONS_FEED_FILE, pullRevocations } from "./revocation-pull.js";

let idDir: string;
let source: string;
let dest: string;
let savedId: string | undefined;
let orgId: string;

/** A revocation of `targetKid`, signed by THIS machine's identity (the org authority in tests). */
function signedRevocation(
  targetKid: string,
  reason = "compromised",
  ts = new Date().toISOString(),
): RevocationRecord {
  const sig = signWithIdentity(revocationStatement(targetKid, ts, reason), idDir).toString(
    "base64",
  );
  return { kid: targetKid, reason, ts, by: orgId, sig };
}

function writeFeed(records: RevocationRecord[]): void {
  writeFileSync(
    join(source, REVOCATIONS_FEED_FILE),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
}

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  source = mkdtempSync(join(tmpdir(), "kit-rev-src-"));
  dest = mkdtempSync(join(tmpdir(), "kit-rev-dest-"));
  savedId = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity(idDir);
  const pub = resolveKeyStore().store.publicKeyPem()!;
  orgId = identityId(pub);
  addPolicySigner(dest, pub, "org"); // this identity is a trusted org revocation authority
});

afterEach(() => {
  if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedId;
  for (const d of [idDir, source, dest]) rmSync(d, { recursive: true, force: true });
});

describe("pullRevocations", () => {
  it("merges an authoritative revocation and it takes effect locally", () => {
    writeFeed([signedRevocation("target-A")]);
    const r = pullRevocations(source, dest, idDir);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.status, "merged");
    assert.equal(r.added, 1);
    assert.equal(r.rejected, 0);
    assert.equal(isRevoked("target-A", idDir), true, "the pulled revocation must be honored");
  });

  it("drops a record whose signer is not an org authority (fail-closed)", () => {
    writeFeed([
      { kid: "target-B", reason: "x", ts: new Date().toISOString(), by: "stranger", sig: "AA==" },
    ]);
    const r = pullRevocations(source, dest, idDir);
    assert.equal(r.added, 0);
    assert.equal(r.rejected, 1);
    assert.equal(isRevoked("target-B", idDir), false);
  });

  it("drops a record with an authorized signer but a forged signature", () => {
    const rec = signedRevocation("target-C");
    rec.sig = "AA=="; // tamper the signature
    writeFeed([rec]);
    const r = pullRevocations(source, dest, idDir);
    assert.equal(r.added, 0);
    assert.equal(r.rejected, 1);
    assert.equal(isRevoked("target-C", idDir), false);
  });

  it("is monotone — a later pull that omits a kid does NOT un-revoke it", () => {
    writeFeed([signedRevocation("keep-revoked")]);
    assert.equal(pullRevocations(source, dest, idDir).added, 1);
    assert.equal(isRevoked("keep-revoked", idDir), true);
    // A new feed WITHOUT keep-revoked must not resurrect the key.
    writeFeed([signedRevocation("someone-else")]);
    const r2 = pullRevocations(source, dest, idDir);
    assert.equal(r2.added, 1);
    assert.equal(isRevoked("keep-revoked", idDir), true, "append-only — never un-revoke");
    assert.equal(isRevoked("someone-else", idDir), true);
  });

  it("dedups — re-pulling the same feed adds nothing", () => {
    writeFeed([signedRevocation("dup", "r", "2026-01-01T00:00:00.000Z")]);
    assert.equal(pullRevocations(source, dest, idDir).added, 1);
    assert.equal(pullRevocations(source, dest, idDir).added, 0);
  });

  it("fail-closed 'no-anchor' when the destination has no local trust anchor", () => {
    const bare = mkdtempSync(join(tmpdir(), "kit-rev-bare-"));
    try {
      writeFeed([signedRevocation("target-D")]);
      const r = pullRevocations(source, bare, idDir);
      assert.equal(r.ok, false);
      assert.equal(r.status, "no-anchor");
      assert.equal(isRevoked("target-D", idDir), false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("'no-source' when the source has no revocations feed", () => {
    const r = pullRevocations(source, dest, idDir);
    assert.equal(r.ok, false);
    assert.equal(r.status, "no-source");
  });
});
