import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
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
  isRevokedWith,
  isAuthoritativeRevocation,
  revokedKids,
  localRevocationAuthorities,
  revocationStatement,
  type RevocationRecord,
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

  it("localPublicKeys rejects a spoofed .bak whose id != fingerprint(publicKey)", () => {
    const d = mkdtempSync(join(tmpdir(), "kit-keypoison-"));
    try {
      process.env.KIT_IDENTITY_DIR = d;
      const me = loadOrCreateIdentity().identity;
      // Attacker drops a .bak claiming to BE `me` (same kid) but carrying THEIR key,
      // trying to poison the kid→pubkey map so a forged revocation "by me" verifies.
      const attacker = generateKeyPairSync("ed25519").publicKey.export({
        type: "spki",
        format: "pem",
      }) as string;
      writeFileSync(
        join(d, "identity.json.2099-01-01T00-00-00-000Z.bak"),
        JSON.stringify({ id: me.id, algo: "ed25519", publicKey: attacker, createdAt: "x" }),
      );
      // The map must still bind `me.id` to the REAL key (fingerprint check rejects the
      // spoof), so the attacker's key can never masquerade as an authority.
      assert.equal(localPublicKeys().get(me.id), me.publicKey);
      assert.notEqual(localPublicKeys().get(me.id), attacker);
    } finally {
      process.env.KIT_IDENTITY_DIR = dir;
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("does NOT honor a planted, unsigned, or unauthorized revocation (authority model)", () => {
    const d = mkdtempSync(join(tmpdir(), "kit-revoke-dos-"));
    try {
      process.env.KIT_IDENTITY_DIR = d;
      const me = loadOrCreateIdentity().identity; // e.g. the org policy signer on this box
      const revPath = join(d, "revocations.jsonl");

      // A writer-only attacker plants a revocation of `me`, claiming some other key
      // signed it, with a junk signature. The old bare existence-check honored this
      // (fail-closed DoS on the real signer); the authority model must not.
      const fromStranger: RevocationRecord = {
        kid: me.id,
        by: "kid_" + "0".repeat(32),
        ts: "2026-01-01T00:00:00Z",
        reason: "pwn",
        sig: Buffer.from("junk").toString("base64"),
      };
      writeFileSync(revPath, JSON.stringify(fromStranger) + "\n");
      assert.equal(loadRevocations().length, 1, "the planted record is on disk");
      assert.equal(isRevoked(me.id), false, "unauthorized revoker must be ignored");

      // Even a forged SELF-revocation (by === kid) fails: the signature can't verify
      // against me's real public key (the attacker cannot forge Ed25519).
      writeFileSync(revPath, JSON.stringify({ ...fromStranger, by: me.id }) + "\n");
      assert.equal(isRevoked(me.id), false, "forged self-revocation with a bad sig is ignored");
    } finally {
      process.env.KIT_IDENTITY_DIR = dir;
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("isAuthoritativeRevocation: self OR authorized signer with a valid sig only", () => {
    const d = mkdtempSync(join(tmpdir(), "kit-revoke-auth-"));
    try {
      process.env.KIT_IDENTITY_DIR = d;
      // `admin` signs a revocation of `victim` (a genuinely different key).
      const victim = loadOrCreateIdentity().identity;
      const { identity: admin } = rotateIdentity(); // admin is now current; signs the record
      const rec = recordRevocation(victim.id, "compromised", undefined, "2026-06-01T00:00:00Z");
      assert.equal(rec.by, admin.id);

      const keys = localPublicKeys(); // { admin, victim(archived) }

      // Authorized: admin is in the authority set → honored.
      assert.equal(isAuthoritativeRevocation(rec, keys, new Set([admin.id])), true);
      // Unauthorized: admin NOT an authority and by !== kid → rejected despite a valid sig.
      assert.equal(isAuthoritativeRevocation(rec, keys, new Set()), false);
      // Revoker's public key unknown → cannot verify → rejected.
      assert.equal(isAuthoritativeRevocation(rec, new Map(), new Set([admin.id])), false);
      // Tampered target (kid) breaks the signature → rejected even though authorized.
      assert.equal(
        isAuthoritativeRevocation(
          { ...rec, kid: "kid_" + "f".repeat(32) },
          keys,
          new Set([admin.id]),
        ),
        false,
      );

      // A self-revocation (by === kid) needs no explicit authority, only a valid sig.
      const selfRec = recordRevocation(admin.id, "retiring", undefined, "2026-06-02T00:00:00Z");
      assert.equal(selfRec.by, admin.id);
      assert.equal(selfRec.kid, admin.id);
      assert.equal(isAuthoritativeRevocation(selfRec, keys, new Set()), true);

      // The default local isRevoked honors admin (the current identity is local root).
      assert.equal(localRevocationAuthorities().has(admin.id), true);
      assert.equal(isRevoked(victim.id), true);
      assert.equal(isRevokedWith(victim.id, keys, new Set([admin.id])), true);

      // revokedKids (the audit-command helper) lists the target under authority…
      assert.equal(revokedKids(keys, new Set([admin.id])).has(victim.id), true);
      // …and lists NOTHING when the revoker is not an authority (authority narrowing:
      // this is why policy-doc drops local root — an unauthorized cross-signer
      // revocation must not veto the target).
      assert.equal(revokedKids(keys, new Set()).has(victim.id), false);
    } finally {
      process.env.KIT_IDENTITY_DIR = dir;
      rmSync(d, { recursive: true, force: true });
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
