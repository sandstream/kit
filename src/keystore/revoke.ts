/**
 * Keystore-routed revocation recording.
 *
 * `recordRevocation` in identity.ts signs with the file-key primitive (correct for the
 * file backend, and fail-closed under the mandate). But on a machine using a `command`
 * (hardware/externally-held) backend, revocations must be signed by — and attributed to —
 * the ACTIVE key, not a coexisting file key: otherwise revocations carry the file kid
 * while audit/memory/policy carry the hardware kid (split-brain attribution), and under a
 * mandate a hardware box could not record a revocation at all.
 *
 * This helper lives in the keystore layer (not identity.ts) so it can import both the
 * keystore and identity primitives without the import cycle identity.ts must avoid.
 */
import { resolveKeyStore } from "./resolve.js";
import { assertHardwareIdentity, hardwareRequired } from "./active.js";
import {
  identityId,
  revocationStatement,
  appendRevocations,
  type RevocationRecord,
} from "../identity.js";

/**
 * Record a revocation of `kid`, signed by the ACTIVE keystore backend and attributed to
 * that backend's key. Honors the hardware mandate (throws if required but not met) and,
 * for the file backend, is equivalent to identity.ts:recordRevocation (same file kid,
 * same statement) — so default behavior is unchanged. The record is appended to the
 * local append-only log (appendRevocations does not re-sign).
 */
export function keystoreRecordRevocation(
  kid: string,
  reason: string,
  dir?: string,
  now: string = new Date().toISOString(),
): RevocationRecord {
  const res = resolveKeyStore({ dir });
  const pub = res.store.publicKeyPem();
  if (!pub) throw new Error("no current identity to sign the revocation");
  // env OR org-policy mandate: fail closed rather than file-sign the revocation.
  assertHardwareIdentity(res, hardwareRequired(process.cwd()));
  const by = identityId(pub);
  // NOTE: signing through the resolved store also records the revoker's PUBLIC key locally
  // (withExternalTrustRecording). That is load-bearing here: isAuthoritativeRevocation refuses a
  // revocation whose revoker is neither the revoked key itself nor a known local authority, so
  // without the record this file's output is inert — the "revoked" key keeps verifying as valid.
  const sig = res.store.sign(revocationStatement(kid, now, reason)).toString("base64");
  const rec: RevocationRecord = { kid, reason, ts: now, by, sig };
  appendRevocations([rec], dir);
  return rec;
}
