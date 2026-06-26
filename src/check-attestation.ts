/**
 * Signed check-attestation receipt.
 *
 * After `kit check` / `kit ci`, kit can emit `.kit-check-attestation.json`: a
 * signed record of WHICH gates ran and that none failed open. It is the
 * artifact a reviewer or CI verifies to know the security gates actually
 * executed (rather than being skipped, errored, or quietly disabled).
 *
 * Signing precedence (decided here, documented in docs/AUDIT_ATTESTATION.md):
 *   1. HMAC-SHA256 with the machine-local audit anchor key - DEFAULT and
 *      AUTHORITATIVE. The verifier needs the same machine-local key, so a valid
 *      MAC genuinely binds the receipt to a key-holder (real authenticity).
 *   2. Ed25519 keypair (`~/.kit/attestation-ed25519.key`, PKCS8 PEM, 0600) -
 *      portable fallback used when the anchor key cannot be obtained, or when
 *      explicitly requested. The receipt embeds its SPKI public key, but that
 *      embedded key is UNTRUSTED: anyone can mint a keypair and sign
 *      `overall_ok: true`. Authenticity therefore requires the verifier to PIN
 *      or pass the expected key (`--key`, or a TOFU pin in `~/.kit`). With no
 *      pin and no expected key the receipt is "unverified-authenticity": the
 *      signature is mathematically valid but the SIGNER is unauthenticated.
 *   3. Unsigned (`sig_alg: "none"`) - last resort. The SIGN step MUST NEVER
 *      block the check from completing, so a total signing failure degrades to
 *      an unsigned receipt with a loud reason rather than throwing.
 *
 * HONESTY: a same-UID attacker who can read the signing key (the HMAC anchor key
 * or an Ed25519 private key) can forge a receipt. A self-signed Ed25519 receipt
 * with no pinned key proves only "integrity of its own claims" - NOT that the
 * gates ran on an untampered host, and NOT who produced it. Same boundary as the
 * audit anchor (audit-anchor.ts).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createHmac,
  createHash,
  timingSafeEqual,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { anchorDir, tryReadAuditAnchorKey, getAuditAnchorKey } from "./audit-anchor.js";
import { secureFile } from "./utils/secure-perms.js";

export const ATTESTATION_FILE = ".kit-check-attestation.json";
const ED25519_KEY_FILE = "attestation-ed25519.key";
const ED25519_PIN_FILE = "attestation-ed25519.pin";

export type SigAlg = "ed25519" | "hmac-sha256" | "none";

export interface AttestationSummary {
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
}

/** The signed body - everything except the signature envelope. */
export interface AttestationPayload {
  schema: "kit-check-attestation/v1";
  command: "check" | "ci";
  timestamp: string;
  kit_version: string;
  overall_ok: boolean;
  results: AttestationSummary;
  /** Scanner ids and whether each actually ran vs was skipped/errored. */
  scanners_ran: { id: string; status: string }[];
}

export interface Attestation extends AttestationPayload {
  sig_alg: SigAlg;
  signature: string;
  /** SPKI PEM public key when sig_alg = ed25519 (lets anyone verify). */
  public_key?: string;
  /** Why the receipt is unsigned, when sig_alg = none. */
  unsigned_reason?: string;
}

export interface BuildAttestationInput {
  command: "check" | "ci";
  kitVersion: string;
  overallOk: boolean;
  results: AttestationSummary;
  scannersRan: { id: string; status: string }[];
  /** Override for deterministic tests. */
  timestamp?: string;
}

/** Build the unsigned payload. Pure. */
export function buildAttestationPayload(input: BuildAttestationInput): AttestationPayload {
  return {
    schema: "kit-check-attestation/v1",
    command: input.command,
    timestamp: input.timestamp ?? new Date().toISOString(),
    kit_version: input.kitVersion,
    overall_ok: input.overallOk,
    results: input.results,
    scanners_ran: input.scannersRan,
  };
}

/**
 * Canonical bytes signed/verified. Stable key order so the same payload always
 * produces the same bytes regardless of object construction order. Pure.
 */
export function canonicalPayloadBytes(payload: AttestationPayload): Buffer {
  const canonical = {
    schema: payload.schema,
    command: payload.command,
    timestamp: payload.timestamp,
    kit_version: payload.kit_version,
    overall_ok: payload.overall_ok,
    results: {
      passed: payload.results.passed,
      failed: payload.results.failed,
      warnings: payload.results.warnings,
      skipped: payload.results.skipped,
    },
    scanners_ran: payload.scanners_ran.map((s) => ({ id: s.id, status: s.status })),
  };
  return Buffer.from(JSON.stringify(canonical), "utf-8");
}

function ed25519KeyPath(dir?: string): string {
  return join(anchorDir(dir), ED25519_KEY_FILE);
}

function ed25519PinPath(dir?: string): string {
  return join(anchorDir(dir), ED25519_PIN_FILE);
}

/**
 * Stable fingerprint of an Ed25519 public key: sha256 over its SPKI DER, hex.
 * Surfaced in verify output and used to compare against an expected/pinned key.
 */
export function ed25519Fingerprint(pub: KeyObject | string): string {
  // createPublicKey() derives a public key from a PRIVATE key / PEM / JWK; it
  // rejects an already-public KeyObject. So only convert strings; use a passed
  // public KeyObject directly.
  const keyObj = typeof pub === "string" ? createPublicKey(pub) : pub;
  const der = keyObj.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

/** Read the TOFU-pinned Ed25519 fingerprint, or null when none is pinned. */
export async function readPinnedEd25519Fingerprint(dir?: string): Promise<string | null> {
  try {
    const fp = (await readFile(ed25519PinPath(dir), "utf-8")).trim().toLowerCase();
    return fp.length > 0 ? fp : null;
  } catch {
    return null;
  }
}

/**
 * Pin an Ed25519 fingerprint as trusted-on-first-use (0600). Later receipts must
 * present a matching key or verify fails. Refuses to silently overwrite an
 * existing, different pin (that would let an attacker re-pin their own key).
 */
export async function pinEd25519Fingerprint(fingerprint: string, dir?: string): Promise<void> {
  const fp = fingerprint.trim().toLowerCase();
  const existing = await readPinnedEd25519Fingerprint(dir);
  if (existing && existing !== fp) {
    throw new Error(
      `an Ed25519 key is already pinned (${existing.slice(0, 16)}…) and differs from this one; refusing to overwrite`,
    );
  }
  await mkdir(anchorDir(dir), { recursive: true });
  const pinPath = ed25519PinPath(dir);
  await writeFile(pinPath, fp + "\n", { encoding: "utf-8", mode: 0o600 });
  secureFile(pinPath);
}

/**
 * Normalize an operator-supplied expected key (`--key`) to a fingerprint. Accepts
 * either an SPKI PEM public key or a raw fingerprint hex (optionally `sha256:`
 * prefixed). Returns null when it cannot be interpreted.
 */
export function expectedKeyToFingerprint(expected: string): string | null {
  const trimmed = expected.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    try {
      return ed25519Fingerprint(trimmed);
    } catch {
      return null;
    }
  }
  const hex = trimmed.replace(/^sha256:/i, "").toLowerCase();
  return /^[0-9a-f]{16,64}$/.test(hex) ? hex : null;
}

/**
 * Load the Ed25519 signing key, creating it on first use (0600). Returns null
 * if it cannot be read or created (sandbox / unwritable home) so the caller can
 * fall back to HMAC. Never throws.
 */
async function loadOrCreateEd25519Key(dir?: string): Promise<KeyObject | null> {
  const keyPath = ed25519KeyPath(dir);
  try {
    const pem = await readFile(keyPath, "utf-8");
    return createPrivateKey(pem);
  } catch {
    /* fall through to create */
  }
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await mkdir(anchorDir(dir), { recursive: true });
    await writeFile(keyPath, pem, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    secureFile(keyPath);
    return privateKey;
  } catch {
    // Lost create race or unwritable home - try one more read before giving up.
    try {
      const pem = await readFile(keyPath, "utf-8");
      return createPrivateKey(pem);
    } catch {
      return null;
    }
  }
}

export interface SignAttestationOptions {
  /** Override the key directory (default ~/.kit). */
  dir?: string;
  /**
   * Force the portable Ed25519 path even when the anchor key is available.
   * Default is the authoritative HMAC path. Ed25519 receipts are only
   * authenticatable by a verifier that pins/expects the key (see header).
   */
  preferEd25519?: boolean;
}

async function signEd25519(
  payload: AttestationPayload,
  bytes: Buffer,
  dir?: string,
): Promise<Attestation | null> {
  const edKey = await loadOrCreateEd25519Key(dir);
  if (!edKey) return null;
  try {
    const signature = cryptoSign(null, bytes, edKey).toString("base64");
    const publicKey = createPublicKey(edKey).export({ type: "spki", format: "pem" }).toString();
    return { ...payload, sig_alg: "ed25519", signature, public_key: publicKey };
  } catch {
    return null;
  }
}

/**
 * Sign a payload into a full attestation. HMAC (anchor key) is the default and
 * authoritative path; Ed25519 is the portable fallback (or when forced). The
 * sign step is fail-soft: if no key can be produced, the receipt is emitted
 * UNSIGNED (sig_alg "none") with a reason - completing the check is never
 * blocked by a signing failure.
 */
export async function signAttestation(
  payload: AttestationPayload,
  options: SignAttestationOptions = {},
): Promise<Attestation> {
  const { dir, preferEd25519 } = options;
  const bytes = canonicalPayloadBytes(payload);

  if (preferEd25519) {
    const ed = await signEd25519(payload, bytes, dir);
    if (ed) return ed;
  }

  // Authoritative default: HMAC with the machine-local anchor key. A valid MAC
  // genuinely binds the receipt to a key-holder (the verifier needs that key).
  const hmacKey =
    (await tryReadAuditAnchorKey(dir).catch(() => null)) ??
    (await getAuditAnchorKey(dir).catch(() => null));
  if (hmacKey) {
    const signature = createHmac("sha256", hmacKey).update(bytes).digest("base64");
    return { ...payload, sig_alg: "hmac-sha256", signature };
  }

  // Portable fallback: Ed25519 (unauthenticated unless the verifier pins it).
  const ed = await signEd25519(payload, bytes, dir);
  if (ed) return ed;

  return {
    ...payload,
    sig_alg: "none",
    signature: "",
    unsigned_reason:
      "no signing key available (could not read/create the ~/.kit anchor key or an Ed25519 key)",
  };
}

/**
 * Verify outcome.
 *   - "ok": signature valid AND signer authenticated (HMAC, or Ed25519 matching
 *     a pinned/expected key).
 *   - "unverified-authenticity": Ed25519 signature is mathematically valid but
 *     no pin/expected key exists, so the SIGNER is unauthenticated. NOT green.
 *   - "failed": signature invalid, key mismatch, or any other failure.
 */
export type AttestationVerifyStatus = "ok" | "unverified-authenticity" | "failed";

export interface AttestationVerifyResult {
  ok: boolean;
  status: AttestationVerifyStatus;
  sig_alg: SigAlg;
  reason: string;
  /** Ed25519 key fingerprint (when applicable), surfaced for pinning. */
  fingerprint?: string;
}

export interface VerifyAttestationOptions {
  /** Override the key directory (default ~/.kit). */
  dir?: string;
  /** Expected Ed25519 key: an SPKI PEM or a fingerprint hex (`--key`). */
  expectedKey?: string;
}

function splitEnvelope(att: Attestation): AttestationPayload {
  return {
    schema: att.schema,
    command: att.command,
    timestamp: att.timestamp,
    kit_version: att.kit_version,
    overall_ok: att.overall_ok,
    results: att.results,
    scanners_ran: att.scanners_ran,
  };
}

/**
 * Verify a receipt. Fail-closed: anything unexpected is a verification failure.
 *
 *   - HMAC: needs the machine-local anchor key (genuine authenticity).
 *   - Ed25519: the embedded public key is UNTRUSTED. The math is checked against
 *     it, then the key's fingerprint is compared to an expected key (`--key`) or
 *     a TOFU pin in ~/.kit. No expected key + no pin => "unverified-authenticity"
 *     (NOT ok). A mismatch => failed (possible forgery).
 */
export async function verifyAttestation(
  att: Attestation,
  options: VerifyAttestationOptions = {},
): Promise<AttestationVerifyResult> {
  const { dir, expectedKey } = options;
  if (att.schema !== "kit-check-attestation/v1") {
    return {
      ok: false,
      status: "failed",
      sig_alg: att.sig_alg,
      reason: "unknown attestation schema",
    };
  }
  const bytes = canonicalPayloadBytes(splitEnvelope(att));

  if (att.sig_alg === "ed25519") {
    if (!att.public_key) {
      return {
        ok: false,
        status: "failed",
        sig_alg: "ed25519",
        reason: "missing embedded public key",
      };
    }
    let pub: KeyObject;
    let fingerprint: string;
    try {
      pub = createPublicKey(att.public_key);
      fingerprint = ed25519Fingerprint(pub);
    } catch (err) {
      return {
        ok: false,
        status: "failed",
        sig_alg: "ed25519",
        reason: `Ed25519 key parse error: ${(err as Error).message}`,
      };
    }
    const mathOk = cryptoVerify(null, bytes, pub, Buffer.from(att.signature, "base64"));
    if (!mathOk) {
      return {
        ok: false,
        status: "failed",
        sig_alg: "ed25519",
        reason: "Ed25519 signature does not verify",
        fingerprint,
      };
    }
    // The signature is mathematically valid; now decide AUTHENTICITY.
    let expectedFp: string | null = null;
    if (expectedKey) {
      expectedFp = expectedKeyToFingerprint(expectedKey);
      if (!expectedFp) {
        return {
          ok: false,
          status: "failed",
          sig_alg: "ed25519",
          reason: "could not parse the expected --key (need an SPKI PEM or a fingerprint hex)",
          fingerprint,
        };
      }
    } else {
      expectedFp = await readPinnedEd25519Fingerprint(dir);
    }
    if (!expectedFp) {
      return {
        ok: false,
        status: "unverified-authenticity",
        sig_alg: "ed25519",
        reason:
          "Ed25519 signature is valid but the SIGNER is unauthenticated: no --key and no pinned key. The embedded key proves integrity of its own claims only - anyone can mint a keypair and sign overall_ok=true. Pin the key (verify --pin) or pass --key to authenticate.",
        fingerprint,
      };
    }
    const matches = expectedFp === fingerprint;
    return matches
      ? {
          ok: true,
          status: "ok",
          sig_alg: "ed25519",
          reason: "valid Ed25519 signature from the pinned/expected key",
          fingerprint,
        }
      : {
          ok: false,
          status: "failed",
          sig_alg: "ed25519",
          reason: `Ed25519 key ${fingerprint.slice(0, 16)}… does not match the expected/pinned key ${expectedFp.slice(0, 16)}… (possible forgery)`,
          fingerprint,
        };
  }

  if (att.sig_alg === "hmac-sha256") {
    const key = await tryReadAuditAnchorKey(dir);
    if (!key) {
      return {
        ok: false,
        status: "failed",
        sig_alg: "hmac-sha256",
        reason: "HMAC receipt but the anchor key is unavailable on this host",
      };
    }
    const expected = createHmac("sha256", key).update(bytes).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(att.signature, "base64");
    } catch {
      return {
        ok: false,
        status: "failed",
        sig_alg: "hmac-sha256",
        reason: "signature not valid base64",
      };
    }
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    return ok
      ? { ok: true, status: "ok", sig_alg: "hmac-sha256", reason: "valid HMAC signature" }
      : {
          ok: false,
          status: "failed",
          sig_alg: "hmac-sha256",
          reason: "HMAC signature does not match",
        };
  }

  return {
    ok: false,
    status: "failed",
    sig_alg: "none",
    reason: "receipt is unsigned (sig_alg=none)",
  };
}

/** Write a receipt to `.kit-check-attestation.json` in `cwd`. */
export async function writeAttestation(att: Attestation, cwd: string): Promise<string> {
  const path = join(cwd, ATTESTATION_FILE);
  await writeFile(path, JSON.stringify(att, null, 2) + "\n", "utf-8");
  return path;
}

/**
 * Build + sign + write a receipt. Fully fail-soft: returns null and prints a
 * warning on any error so the calling check command's verdict is never altered
 * by attestation problems.
 */
export async function emitAttestation(
  input: BuildAttestationInput,
  cwd: string,
  dir?: string,
): Promise<{ path: string; att: Attestation } | null> {
  try {
    const payload = buildAttestationPayload(input);
    const att = await signAttestation(payload, { dir });
    const path = await writeAttestation(att, cwd);
    return { path, att };
  } catch (err) {
    console.error(`[kit] check attestation not emitted: ${(err as Error).message}`);
    return null;
  }
}
