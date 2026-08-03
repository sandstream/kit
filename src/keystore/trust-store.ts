/**
 * Local trust record for an EXTERNALLY-HELD identity (Pillar 1).
 *
 * The gap this closes: kit's local trust store (`localPublicKeys` in ../identity.ts) is built
 * from `identity.json` + its archived `.bak` records — all of which describe the kit-MANAGED
 * file key. An operator-fronted key (KIT_KEYSTORE=command → TPM/HSM/enclave/YubiKey) never
 * appears there, so before this record existed:
 *
 *   - `kit profile sign` under a hardware backend succeeded, and `kit profile verify` on the
 *     SAME machine a second later reported "signer <kid> unknown" — kit could not verify what
 *     it had just signed. Everything downstream of a verified scope (the exec-broker policy in
 *     Pillar 3) therefore resolved to null, so adopting the hardware backend Pillar 1
 *     recommends silently disabled the mediation Pillar 3 promises.
 *   - `kit identity migrate` recorded a revocation of the old file key SIGNED BY the new
 *     external key. `isAuthoritativeRevocation` rejects a revoker whose public key is unknown,
 *     so the revocation was inert: the "revoked" file key kept signing and verifying as valid,
 *     with no warning on any surface.
 *
 * So the public half of an external identity has to be written down. It is PUBLIC data — the
 * private key stays wherever the operator's command fronts it; kit still never holds it.
 *
 * TRUST SURFACE, honestly: this file is same-UID writable, like `identity.json` and the `.bak`
 * records already read by the same trust store. An attacker with write access to the identity
 * dir can plant their OWN key here and thereby nominate a revocation authority (a fail-closed
 * DoS: revoke a real signer). Two things bound that, both pre-existing: the kid==fingerprint
 * (publicKey) binding in `localPublicKeys` means a planted record cannot IMPERSONATE an
 * existing kid, and write access to the identity dir is already outside the documented threat
 * boundary (under the file backend it hands over the private key outright). What this record
 * does NOT do is let anyone sign — that still requires the operator's hardware.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityDir, identityId, type Identity } from "../identity.js";
import { secureFile } from "../utils/secure-perms.js";
import type { KeyStore } from "./types.js";

/** Public record of the active externally-held identity (0600, no private material). */
export const EXTERNAL_RECORD_FILE = "identity.external.json";

/** The persisted shape: an `Identity` plus which backend fronted it. */
export interface ExternalIdentityRecord extends Identity {
  /** The backend that held the key when this record was written ("command", …). */
  backend: string;
}

function externalRecordPath(dir?: string): string {
  return join(identityDir(dir), EXTERNAL_RECORD_FILE);
}

/**
 * Read the external identity record, or null when absent/malformed/self-inconsistent. The
 * kid MUST be the fingerprint of the recorded public key — the same binding `localPublicKeys`
 * applies — so a hand-edited record claiming someone else's kid is ignored rather than trusted.
 */
export function readExternalIdentity(dir?: string): ExternalIdentityRecord | null {
  try {
    const rec = JSON.parse(
      readFileSync(externalRecordPath(dir), "utf-8"),
    ) as ExternalIdentityRecord;
    if (!rec || typeof rec.id !== "string" || typeof rec.publicKey !== "string") return null;
    if (identityId(rec.publicKey) !== rec.id) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Record the resolved keystore's public key as a locally-trusted identity, when that keystore
 * is external (non-file). Idempotent: rewrites only when the key actually changed, so repeated
 * signing does not churn the file. Returns the recorded kid, or null when there is nothing to
 * record (file backend, no public key) or the write failed.
 *
 * Best-effort by design: a failure here must not break signing. The consequence of a failed
 * write is the honest pre-existing behaviour — `kit profile verify` reporting the signer as
 * unknown — not a silent claim of validity.
 */
export function recordExternalIdentity(
  store: Pick<KeyStore, "kind" | "publicKeyPem">,
  dir?: string,
): string | null {
  if (store.kind === "file") return null;
  let pub: string | null;
  try {
    pub = store.publicKeyPem();
  } catch {
    return null;
  }
  if (!pub) return null;
  try {
    const id = identityId(pub);
    const existing = readExternalIdentity(dir);
    if (existing && existing.id === id) return id;
    const rec: ExternalIdentityRecord = {
      id,
      algo: "ed25519",
      publicKey: pub,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      backend: store.kind,
    };
    const path = externalRecordPath(dir);
    mkdirSync(identityDir(dir), { recursive: true });
    writeFileSync(path, JSON.stringify(rec, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    secureFile(path);
    return id;
  } catch {
    return null;
  }
}

/** True when an external identity record exists on this machine. */
export function hasExternalIdentity(dir?: string): boolean {
  return existsSync(externalRecordPath(dir));
}

/**
 * Wrap a store so that a SUCCESSFUL sign() also records its public key locally. Applied once,
 * inside `resolveKeyStore`, so every signing path gets it — `signProfile`, the audit chain,
 * `kit policy sign`, shared-memory entries, `keystoreSign`, and anything added later. Doing it
 * per-call-site instead would work today and rot on the next one.
 *
 * The file backend is returned untouched: its public key is already in `identity.json`.
 */
export function withExternalTrustRecording(store: KeyStore, dir?: string): KeyStore {
  if (store.kind === "file") return store;
  const wrapped: KeyStore = {
    kind: store.kind,
    available: () => store.available(),
    publicKeyPem: () => store.publicKeyPem(),
    sign: (data) => {
      const sig = store.sign(data); // throws → nothing recorded, nothing claimed
      recordExternalIdentity(store, dir);
      return sig;
    },
    create: (now) => store.create(now),
    rotate: (now) => store.rotate(now),
  };
  return wrapped;
}
