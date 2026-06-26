import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, createPublicKey, sign as cryptoSign } from "node:crypto";
import {
  buildAttestationPayload,
  canonicalPayloadBytes,
  signAttestation,
  verifyAttestation,
  emitAttestation,
  ed25519Fingerprint,
  pinEd25519Fingerprint,
  ATTESTATION_FILE,
  type Attestation,
  type AttestationPayload,
  type BuildAttestationInput,
} from "./check-attestation.js";

const SAMPLE: BuildAttestationInput = {
  command: "check",
  kitVersion: "1.39.0",
  overallOk: true,
  results: { passed: 10, failed: 0, warnings: 1, skipped: 2 },
  scannersRan: [
    { id: "gitleaks", status: "ran" },
    { id: "semgrep", status: "not-installed" },
  ],
  timestamp: "2026-06-26T00:00:00.000Z",
};

describe("check-attestation - payload + canonicalization", () => {
  it("canonical bytes are stable regardless of field insertion order", () => {
    const p1 = buildAttestationPayload(SAMPLE);
    const p2 = buildAttestationPayload({ ...SAMPLE });
    assert.ok(canonicalPayloadBytes(p1).equals(canonicalPayloadBytes(p2)));
  });

  it("canonical bytes change when a result count changes", () => {
    const a = canonicalPayloadBytes(buildAttestationPayload(SAMPLE));
    const b = canonicalPayloadBytes(
      buildAttestationPayload({ ...SAMPLE, results: { ...SAMPLE.results, failed: 1 } }),
    );
    assert.ok(!a.equals(b));
  });
});

describe("check-attestation - HMAC is the authoritative default", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-att-hmac-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("signs with HMAC by default and verifies via the machine-local anchor key", async () => {
    const att = await signAttestation(buildAttestationPayload(SAMPLE), { dir });
    assert.equal(att.sig_alg, "hmac-sha256");
    const r = await verifyAttestation(att, { dir });
    assert.equal(r.ok, true);
    assert.equal(r.status, "ok");
    assert.equal(r.sig_alg, "hmac-sha256");
  });

  it("a tampered HMAC receipt fails verification", async () => {
    const att = await signAttestation(buildAttestationPayload(SAMPLE), { dir });
    const tampered: Attestation = { ...att, overall_ok: false };
    const r = await verifyAttestation(tampered, { dir });
    assert.equal(r.ok, false);
    assert.equal(r.status, "failed");
  });

  it("an HMAC receipt with a wrong signature fails", async () => {
    const { getAuditAnchorKey } = await import("./audit-anchor.js");
    await getAuditAnchorKey(dir); // ensure a key exists to verify against
    const att: Attestation = {
      ...buildAttestationPayload(SAMPLE),
      sig_alg: "hmac-sha256",
      signature: Buffer.from("not-the-real-mac").toString("base64"),
    };
    const r = await verifyAttestation(att, { dir });
    assert.equal(r.ok, false);
    assert.equal(r.status, "failed");
  });
});

describe("check-attestation - Ed25519 authenticity (FIX 1: embedded key is untrusted)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-att-ed-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Mint a fully self-signed, green Ed25519 receipt (the forgery attack). */
  function forgeGreenEd25519Receipt(payload: AttestationPayload): {
    att: Attestation;
    fingerprint: string;
  } {
    const { privateKey } = generateKeyPairSync("ed25519");
    const bytes = canonicalPayloadBytes(payload);
    const signature = cryptoSign(null, bytes, privateKey).toString("base64");
    const publicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    return {
      att: { ...payload, sig_alg: "ed25519", signature, public_key: publicKey },
      fingerprint: ed25519Fingerprint(publicKey),
    };
  }

  it("ATTACK: a forged fresh-keypair green receipt is NOT ok without a pin", async () => {
    const { att } = forgeGreenEd25519Receipt(buildAttestationPayload(SAMPLE));
    const r = await verifyAttestation(att, { dir }); // no pin, no --key
    assert.equal(r.ok, false);
    assert.equal(r.status, "unverified-authenticity");
    assert.ok(r.fingerprint, "fingerprint surfaced");
  });

  it("ATTACK: a forged receipt FAILS against a pin that does not match", async () => {
    const { att } = forgeGreenEd25519Receipt(buildAttestationPayload(SAMPLE));
    // Pin a different (genuine) key first.
    const { privateKey: other } = generateKeyPairSync("ed25519");
    const otherFp = ed25519Fingerprint(
      createPublicKey(other).export({ type: "spki", format: "pem" }).toString(),
    );
    await pinEd25519Fingerprint(otherFp, dir);

    const r = await verifyAttestation(att, { dir });
    assert.equal(r.ok, false);
    assert.equal(r.status, "failed");
    assert.match(r.reason, /does not match/);
  });

  it("verifies ok when the embedded key matches an explicit --key", async () => {
    const att = await signAttestation(buildAttestationPayload(SAMPLE), {
      dir,
      preferEd25519: true,
    });
    assert.equal(att.sig_alg, "ed25519");
    const fp = ed25519Fingerprint(att.public_key!);
    const r = await verifyAttestation(att, { dir, expectedKey: fp });
    assert.equal(r.ok, true);
    assert.equal(r.status, "ok");
  });

  it("verifies ok against a TOFU pin of the genuine key, then a forgery fails", async () => {
    const att = await signAttestation(buildAttestationPayload(SAMPLE), {
      dir,
      preferEd25519: true,
    });
    const fp = ed25519Fingerprint(att.public_key!);
    await pinEd25519Fingerprint(fp, dir);

    const good = await verifyAttestation(att, { dir });
    assert.equal(good.ok, true);

    // A forged receipt (different key) now fails against the established pin.
    const { att: forged } = forgeGreenEd25519Receipt(buildAttestationPayload(SAMPLE));
    const bad = await verifyAttestation(forged, { dir });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, "failed");
  });

  it("a mathematically broken Ed25519 signature fails before authenticity", async () => {
    const att = await signAttestation(buildAttestationPayload(SAMPLE), {
      dir,
      preferEd25519: true,
    });
    const tampered: Attestation = { ...att, overall_ok: false };
    const r = await verifyAttestation(tampered, { dir });
    assert.equal(r.ok, false);
    assert.equal(r.status, "failed");
    assert.match(r.reason, /does not verify/);
  });

  it("pinEd25519Fingerprint refuses to overwrite a different existing pin", async () => {
    await pinEd25519Fingerprint("a".repeat(64), dir);
    await assert.rejects(() => pinEd25519Fingerprint("b".repeat(64), dir), /refusing to overwrite/);
  });
});

describe("check-attestation - emit writes the receipt file", () => {
  it("emitAttestation writes .kit-check-attestation.json and it verifies (HMAC)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-att-emit-"));
    const dir = mkdtempSync(join(tmpdir(), "kit-att-emith-"));
    try {
      const res = await emitAttestation(SAMPLE, cwd, dir);
      assert.ok(res);
      const onDisk = JSON.parse(
        await readFile(join(cwd, ATTESTATION_FILE), "utf-8"),
      ) as Attestation;
      assert.equal(onDisk.command, "check");
      assert.equal(onDisk.sig_alg, "hmac-sha256");
      const r = await verifyAttestation(onDisk, { dir });
      assert.equal(r.ok, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
