/**
 * KeyStore port — Pillar 1: hardware-rooted identity behind an interface.
 *
 * This is the abstraction seam that lets kit's Ed25519 private key migrate from
 * the current 0600 PKCS8 PEM file under ~/.kit to NON-EXPORTABLE hardware
 * (Apple Secure Enclave / TPM 2.0 / PKCS#11) later, WITHOUT touching the
 * deterministic offline verifier: `verifySignature` in ../identity.js stays a
 * pure function over a public PEM and is deliberately NOT part of this port.
 *
 * The interface is intentionally SYNCHRONOUS to match ../identity.js and its
 * many sync callers. Real hardware APIs are async; adopting one is an explicit
 * future migration (see the "risks" note in the design), not a reason to
 * async-ify the whole call graph now.
 *
 * No I/O and no imports beyond the Identity TYPE — this file is pure contract.
 */
import type { Identity } from "../identity.js";

/** The backends kit knows about. "file" is the working default today; "command" is the
 *  first REAL hardware-rooted backend (operator-fronted TPM/HSM/enclave, key never in
 *  kit); "secure-enclave"/"tpm" are native stubs pending a working binding. */
export type KeyStoreKind = "file" | "command" | "secure-enclave" | "tpm";

/** Whether a backend can operate in the CURRENT environment. Honest, never faked. */
export interface KeyStoreAvailability {
  ok: boolean;
  /** Present whenever ok===false: the platform/implementation requirement. */
  reason?: string;
}

/**
 * The port contract every backend implements. create()/rotate() return the SAME
 * `Identity` shape (SPKI PEM public key) that ../identity.js callers already
 * know, so a hardware backend is drop-in for the record contract.
 */
export interface KeyStore {
  readonly kind: KeyStoreKind;
  /** Can this backend operate in the CURRENT env? Never throws. */
  available(): KeyStoreAvailability;
  /** SPKI PEM of the public key, or null if none exists yet. Never throws. */
  publicKeyPem(): string | null;
  /** Ed25519 signature over data. Throws (fail-closed) if unavailable or no key. */
  sign(data: Buffer | string): Buffer;
  /** Create the identity/key if absent; idempotent. */
  create(now?: string): { identity: Identity; created: boolean };
  /** Rotate: archive old, generate new. */
  rotate(now?: string): { identity: Identity; previousId: string | null };
}

/**
 * The result of resolveKeyStore(): the chosen store PLUS the full honesty trail.
 * `degraded` is true whenever the chosen backend is not the strongest possible
 * (fell back to file, or a forced hardware backend is unavailable); `reason` is
 * ALWAYS set when degraded (no silent downgrade). `considered` is the audit
 * trail of every backend inspected and its availability.
 */
export interface KeyStoreResolution {
  store: KeyStore;
  availability: KeyStoreAvailability;
  degraded: boolean;
  reason?: string;
  considered: { kind: KeyStoreKind; availability: KeyStoreAvailability }[];
}
