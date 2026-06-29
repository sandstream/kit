import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  loadOrCreateIdentity,
  tryLoadIdentity,
  rotateIdentity,
  signWithIdentity,
  verifySignature,
  identityId,
  localPublicKeys,
  recordRevocation,
  loadRevocations,
  isRevoked,
  revocationStatement,
} from "./identity.js";

describe("identity", () => {
  let dir: string;
  const prev = process.env.KIT_IDENTITY_DIR;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-identity-"));
    process.env.KIT_IDENTITY_DIR = dir;
  });
  after(() => {
    if (prev === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates an identity on first use, then is idempotent", () => {
    const first = loadOrCreateIdentity();
    assert.equal(first.created, true);
    assert.match(first.identity.id, /^kid_[0-9a-f]{32}$/);
    assert.equal(first.identity.algo, "ed25519");
    assert.ok(first.identity.publicKey.includes("BEGIN PUBLIC KEY"));
    const second = loadOrCreateIdentity();
    assert.equal(second.created, false, "second call must not regenerate");
    assert.equal(second.identity.id, first.identity.id);
  });

  it("stores the private key owner-only (0600 on POSIX)", () => {
    loadOrCreateIdentity();
    const keyFile = join(dir, "identity.key");
    assert.ok(existsSync(keyFile));
    if (process.platform !== "win32") {
      assert.equal(statSync(keyFile).mode & 0o077, 0, "no group/other access");
    }
  });

  it("id is the fingerprint of the public key", () => {
    const { identity } = loadOrCreateIdentity();
    assert.equal(identityId(identity.publicKey), identity.id);
  });

  it("signs with the private key and verifies with the public key (asymmetric)", () => {
    const { identity } = loadOrCreateIdentity();
    const sig = signWithIdentity("audit-entry-42");
    assert.equal(verifySignature("audit-entry-42", sig, identity.publicKey), true);
  });

  it("rejects a tampered message and a wrong key (fail-closed)", () => {
    const { identity } = loadOrCreateIdentity();
    const sig = signWithIdentity("audit-entry-42");
    assert.equal(verifySignature("audit-entry-43", sig, identity.publicKey), false);
    const otherPub = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    assert.equal(verifySignature("audit-entry-42", sig, otherPub), false);
    assert.equal(
      verifySignature("audit-entry-42", sig, "not a key"),
      false,
      "malformed key → false",
    );
  });

  it("rotate produces a new id and reports the previous one", () => {
    const before = loadOrCreateIdentity().identity;
    const { identity: after, previousId } = rotateIdentity();
    assert.notEqual(after.id, before.id, "rotation yields a new identity");
    assert.equal(previousId, before.id);
    // The live record is now the rotated identity.
    assert.equal(tryLoadIdentity()?.id, after.id);
  });

  it("localPublicKeys returns the current key plus archived (rotated) keys", () => {
    const own = mkdtempSync(join(tmpdir(), "kit-identity-keys-"));
    try {
      process.env.KIT_IDENTITY_DIR = own;
      const first = loadOrCreateIdentity().identity;
      const { identity: second } = rotateIdentity();
      const keys = localPublicKeys();
      // Current identity resolves...
      assert.equal(keys.get(second.id), second.publicKey);
      // ...and so does the rotated-away predecessor (archived .bak record).
      assert.equal(keys.get(first.id), first.publicKey);
      assert.equal(keys.size, 2);
    } finally {
      process.env.KIT_IDENTITY_DIR = dir;
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("records a signed revocation that verifies against the signer's public key", () => {
    const own = mkdtempSync(join(tmpdir(), "kit-revoke-"));
    try {
      process.env.KIT_IDENTITY_DIR = own;
      const victim = loadOrCreateIdentity().identity; // the key we'll revoke
      const { identity: signer } = rotateIdentity(); // new key signs the revocation
      assert.equal(isRevoked(victim.id), false);
      const rec = recordRevocation(victim.id, "device lost", undefined, "2026-06-29T00:00:00Z");
      assert.equal(rec.kid, victim.id);
      assert.equal(rec.by, signer.id);
      // the revocation signature verifies with the SIGNER's public key (asymmetric)
      assert.equal(
        verifySignature(
          revocationStatement(victim.id, "2026-06-29T00:00:00Z", "device lost"),
          Buffer.from(rec.sig, "base64"),
          signer.publicKey,
        ),
        true,
      );
      assert.equal(isRevoked(victim.id), true);
      assert.equal(loadRevocations().length, 1);
    } finally {
      process.env.KIT_IDENTITY_DIR = dir;
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("isRevoked is false for unknown keys and loadRevocations is [] with no store", () => {
    const empty = mkdtempSync(join(tmpdir(), "kit-norevoke-"));
    try {
      process.env.KIT_IDENTITY_DIR = empty;
      assert.equal(isRevoked("kid_whatever"), false);
      assert.deepEqual(loadRevocations(), []);
    } finally {
      process.env.KIT_IDENTITY_DIR = dir;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("tryLoadIdentity returns null when no identity exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "kit-identity-empty-"));
    try {
      process.env.KIT_IDENTITY_DIR = empty;
      assert.equal(tryLoadIdentity(), null);
    } finally {
      process.env.KIT_IDENTITY_DIR = dir;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
