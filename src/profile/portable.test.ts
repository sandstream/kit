import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadOrCreateIdentity, identityId, recordRevocation } from "../identity.js";
import { resolveKeyStore } from "../keystore/index.js";
import { addPolicySigner } from "../policy-trust.js";
import { PROFILE_FILE } from "./schema.js";
import { signProfile, PROFILE_SIG_FILE } from "./sign.js";
import { exportBundle, importBundle, type ProfileBundle } from "./portable.js";

let idDir: string;
let src: string;
let dest: string;
let savedId: string | undefined;

const PROFILE = `version = 1\n[scope]\negress = ["api.acme.com"]\nsign = ["api.acme.com"]\n`;

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  src = mkdtempSync(join(tmpdir(), "kit-src-"));
  dest = mkdtempSync(join(tmpdir(), "kit-dest-"));
  savedId = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity();
});

afterEach(() => {
  if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedId;
  for (const d of [idDir, src, dest]) rmSync(d, { recursive: true, force: true });
});

async function signedSource(): Promise<void> {
  writeFileSync(join(src, PROFILE_FILE), PROFILE, "utf-8");
  const r = await signProfile(src);
  assert.equal(r.ok, true, r.error);
}

describe("profile portable — export", () => {
  it("fails to export an unsigned profile", () => {
    writeFileSync(join(src, PROFILE_FILE), PROFILE, "utf-8");
    const r = exportBundle(src);
    assert.equal(r.ok, false);
    assert.match(r.error!, /profile sign/);
  });

  it("exports a signed profile with the signer public key bound to the kid", async () => {
    await signedSource();
    const r = exportBundle(src);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.bundle!.kit_bundle, 1);
    assert.equal(identityId(r.bundle!.signer_pubkey), r.bundle!.signature.kid);
  });
});

describe("profile portable — import (fresh host, no local identity/anchor)", () => {
  // Simulate a fresh host: point the identity dir elsewhere so the signer is unknown locally.
  const freshHost = () => {
    const other = mkdtempSync(join(tmpdir(), "kit-fresh-"));
    process.env.KIT_IDENTITY_DIR = other;
    loadOrCreateIdentity();
    return other;
  };

  it("integrity-verifies on a fresh host but reports UNANCHORED (not yet authoritative)", async () => {
    await signedSource();
    const bundle = exportBundle(src).bundle!;
    const other = freshHost();
    try {
      const r = importBundle(bundle, dest);
      assert.equal(r.status, "imported-unanchored", r.detail);
      assert.ok(existsSync(resolve(dest, PROFILE_FILE)), "profile written");
      assert.ok(existsSync(resolve(dest, PROFILE_SIG_FILE)), "signature written");
      assert.equal(readFileSync(resolve(dest, PROFILE_FILE), "utf-8"), PROFILE);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("reports imported-trusted when the signer IS in the destination org anchor", async () => {
    await signedSource();
    const bundle = exportBundle(src).bundle!;
    // Anchor the signer at the destination BEFORE import.
    addPolicySigner(dest, resolveKeyStore().store.publicKeyPem()!, "org");
    const r = importBundle(bundle, dest);
    assert.equal(r.status, "imported-trusted", r.detail);
  });
});

describe("profile portable — fail-closed", () => {
  it("rejects a bundle whose profile was altered after signing (fingerprint mismatch)", async () => {
    await signedSource();
    const bundle = exportBundle(src).bundle!;
    const tampered: ProfileBundle = {
      ...bundle,
      profile: bundle.profile + '\nx_tamper = "evil"\n',
    };
    const r = importBundle(tampered, dest);
    assert.equal(r.status, "invalid");
    assert.ok(!existsSync(resolve(dest, PROFILE_FILE)), "nothing written on invalid");
  });

  it("rejects a swapped public key (pubkey does not match the signature kid)", async () => {
    await signedSource();
    const bundle = exportBundle(src).bundle!;
    // Generate a different identity's public key and swap it in.
    const evilDir = mkdtempSync(join(tmpdir(), "kit-evil-"));
    process.env.KIT_IDENTITY_DIR = evilDir;
    loadOrCreateIdentity();
    const evilPub = resolveKeyStore().store.publicKeyPem()!;
    try {
      const swapped: ProfileBundle = { ...bundle, signer_pubkey: evilPub };
      const r = importBundle(swapped, dest);
      assert.equal(r.status, "invalid");
      assert.match(r.detail, /does not match signature kid/);
    } finally {
      rmSync(evilDir, { recursive: true, force: true });
    }
  });

  it("refuses a bundle from a revoked signer", async () => {
    await signedSource();
    const bundle = exportBundle(src).bundle!;
    // Anchor + revoke the signer at the destination's identity context.
    addPolicySigner(dest, resolveKeyStore().store.publicKeyPem()!, "org");
    recordRevocation(bundle.signature.kid, "compromised", idDir);
    const r = importBundle(bundle, dest, { dir: idDir });
    assert.equal(r.status, "revoked");
    assert.ok(!existsSync(resolve(dest, PROFILE_FILE)), "nothing written on revoked");
  });

  it("rejects a malformed bundle", () => {
    const r = importBundle({ not: "a bundle" }, dest);
    assert.equal(r.status, "malformed");
  });

  it("never writes the trust anchor on import", async () => {
    await signedSource();
    const bundle = exportBundle(src).bundle!;
    importBundle(bundle, dest);
    assert.ok(
      !existsSync(resolve(dest, ".kit-policy.signers")),
      "anchor must never be written by import",
    );
  });
});
