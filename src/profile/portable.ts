/**
 * kit traveling profile (Pillar 4) — portable export/import so a signed profile can move to a FRESH
 * host and be re-verified offline.
 *
 * A signed profile is `.kit-profile.toml` + `.kit-profile.sig`, verified against a locally-known
 * signer key or the org trust anchor (`.kit-policy.signers`). On a brand-new machine neither is
 * present, so the profile is "unverifiable" — its integrity cannot even be checked. This module
 * packages the profile + signature + the SIGNER'S PUBLIC KEY into one portable bundle, so a fresh
 * host can verify **integrity** (the profile was not tampered since signing) entirely offline.
 *
 * Trust model (mirrors the control-plane "verify before apply, no root-trust-from-the-network"):
 *   - **Integrity** is proven by the bundled public key — BUT only after binding it to the signature:
 *     `identityId(pubkey) === signature.kid`, so an attacker cannot swap in their own key.
 *   - **Authority** is NOT granted by the bundle. A bundled key proves "not tampered", never "trusted
 *     source". Import reports whether the signer is in the LOCAL org anchor; it never writes the
 *     anchor. An imported profile only becomes authoritative once the signer is anchored
 *     (`kit policy trust add`) — until then `verifyProfileSignature` still returns "unverifiable".
 *   - A signature that fails integrity, or whose signer is revoked, is REFUSED (nothing written).
 *
 * Deterministic, offline, zero-LLM.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROFILE_FILE, parseProfile, canonicalProfileBytes, profileFingerprint } from "./schema.js";
import { PROFILE_SIG_FILE, getProfileSigPath } from "./sign.js";
import type { PolicySignature } from "../policy-doc.js";
import {
  identityId,
  verifySignature,
  localPublicKeys,
  isRevokedWith,
  tryLoadIdentity,
} from "../identity.js";
import { policySignersMap, hasPolicyAnchor } from "../policy-trust.js";

/** Portable, self-contained profile bundle. Plain JSON — commit it, email it, carry it on a stick. */
export interface ProfileBundle {
  /** Bundle format version. */
  kit_bundle: 1;
  /** The exact `.kit-profile.toml` bytes (verbatim, so import writes a faithful copy). */
  profile: string;
  /** The `.kit-profile.sig` record. */
  signature: PolicySignature;
  /** SPKI PEM of the signer — lets a fresh host check integrity offline (bound to signature.kid). */
  signer_pubkey: string;
}

export interface ExportResult {
  ok: boolean;
  bundle?: ProfileBundle;
  error?: string;
}

/**
 * Build a portable bundle from the signed profile at `cwd`. Requires a profile, a signature, and a
 * resolvable public key for the signing kid (from the local identity set). Never throws.
 */
export function exportBundle(cwd = process.cwd()): ExportResult {
  const profilePath = resolve(cwd, PROFILE_FILE);
  if (!existsSync(profilePath)) return { ok: false, error: "no profile to export" };
  let profile: string;
  try {
    profile = readFileSync(profilePath, "utf-8");
  } catch (e) {
    return {
      ok: false,
      error: `cannot read profile: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!existsSync(getProfileSigPath(cwd))) {
    return { ok: false, error: `no ${PROFILE_SIG_FILE} — run 'kit profile sign' before exporting` };
  }
  let signature: PolicySignature;
  try {
    signature = JSON.parse(readFileSync(getProfileSigPath(cwd), "utf-8")) as PolicySignature;
  } catch {
    return { ok: false, error: `unreadable ${PROFILE_SIG_FILE}` };
  }
  // Resolve the signer's public key: local identity set first, then the current identity.
  let pub = localPublicKeys().get(signature.kid);
  if (!pub) {
    const self = tryLoadIdentity();
    if (self && self.id === signature.kid) pub = self.publicKey;
  }
  if (!pub) {
    return {
      ok: false,
      error: `no public key for signer ${signature.kid} on this host — export from the signing machine`,
    };
  }
  return { ok: true, bundle: { kit_bundle: 1, profile, signature, signer_pubkey: pub } };
}

export type ImportStatus =
  | "imported-trusted" // integrity ok, signer anchored (authoritative) & not revoked
  | "imported-unanchored" // integrity ok, but signer not in the local anchor — not yet authoritative
  | "invalid" // integrity failed (tamper / pubkey↔kid mismatch) — nothing written
  | "revoked" // signer is revoked — nothing written
  | "malformed"; // the bundle itself is not a valid ProfileBundle

export interface ImportResult {
  status: ImportStatus;
  detail: string;
  kid?: string;
  fingerprint?: string;
  /** Whether a local org trust anchor (.kit-policy.signers) exists at the destination. */
  anchored?: boolean;
}

function isBundle(v: unknown): v is ProfileBundle {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    b.kit_bundle === 1 &&
    typeof b.profile === "string" &&
    typeof b.signer_pubkey === "string" &&
    typeof b.signature === "object" &&
    b.signature !== null
  );
}

/**
 * Verify and install a portable bundle at `destRoot`. Proves integrity offline against the bundled
 * key (bound to the signature kid), refuses tamper/revoked, and reports the authority posture. On
 * success (integrity ok, not revoked) it writes `.kit-profile.toml` + `.kit-profile.sig`; it NEVER
 * writes the trust anchor. Never throws.
 */
export function importBundle(
  bundle: unknown,
  destRoot: string,
  opts: { dir?: string } = {},
): ImportResult {
  if (!isBundle(bundle)) return { status: "malformed", detail: "not a kit profile bundle" };

  // Parse + fingerprint the carried profile.
  let fingerprint: string;
  try {
    fingerprint = profileFingerprint(parseProfile(bundle.profile));
  } catch (e) {
    return {
      status: "invalid",
      detail: `unparseable profile: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const { signature, signer_pubkey } = bundle;

  // Bind the bundled key to the claimed signer — an attacker must not be able to swap the pubkey.
  let derivedKid: string;
  try {
    derivedKid = identityId(signer_pubkey);
  } catch {
    return { status: "invalid", detail: "bundled signer_pubkey is not a valid key" };
  }
  if (derivedKid !== signature.kid) {
    return {
      status: "invalid",
      detail: `bundled key ${derivedKid} does not match signature kid ${signature.kid}`,
      kid: signature.kid,
    };
  }

  // Integrity: fingerprint must match AND the signature must verify over the canonical bytes.
  const fpMatches = signature.fingerprint === fingerprint;
  const sigOk =
    fpMatches &&
    verifySignature(
      canonicalProfileBytes(parseProfile(bundle.profile)),
      Buffer.from(signature.sig, "base64"),
      signer_pubkey,
    );
  if (!sigOk) {
    return {
      status: "invalid",
      detail: fpMatches ? "signature does not verify" : "fingerprint mismatch (profile altered)",
      kid: signature.kid,
      fingerprint,
    };
  }

  // Revocation: honor local + org authorities (self-revoke or an org-anchor signer).
  const orgSigners = policySignersMap(destRoot);
  const trustedKeys = new Map<string, string>([
    ...localPublicKeys(opts.dir),
    ...orgSigners,
    [signature.kid, signer_pubkey],
  ]);
  const authorities = new Set<string>(orgSigners.keys());
  if (isRevokedWith(signature.kid, trustedKeys, authorities, opts.dir)) {
    return {
      status: "revoked",
      detail: `signer ${signature.kid} is revoked`,
      kid: signature.kid,
      fingerprint,
    };
  }

  // Integrity proven → write the profile + signature (but never the anchor).
  writeFileSync(resolve(destRoot, PROFILE_FILE), bundle.profile, "utf-8");
  writeFileSync(getProfileSigPath(destRoot), JSON.stringify(signature, null, 2) + "\n", "utf-8");

  const anchored = hasPolicyAnchor(destRoot);
  const authoritative = orgSigners.has(signature.kid);
  if (authoritative) {
    return {
      status: "imported-trusted",
      detail: `imported and verified — signer ${signature.kid} is in the org trust anchor`,
      kid: signature.kid,
      fingerprint,
      anchored,
    };
  }
  return {
    status: "imported-unanchored",
    detail: `imported with integrity verified, but signer ${signature.kid} is not in the local trust anchor — run 'kit policy trust add' to make it authoritative`,
    kid: signature.kid,
    fingerprint,
    anchored,
  };
}
