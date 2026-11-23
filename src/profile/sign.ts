/**
 * kit project profile — signed scope/RoE (Pillar 4 step 5).
 * The profile's `[scope]` section (egress allowlist, fs-scope, secret-scope) is only meaningful
 * as a security boundary if it is CRYPTOGRAPHICALLY ATTRIBUTABLE and offline-verifiable — a
 * hand-editable file can't gate an autonomous agent. So the profile reuses, verbatim, the
 * signing floor kit already ships for `.kit-policy.toml`:
 *
 *   - sign over CANONICAL bytes (`canonicalProfileBytes`, `generated` excluded) through the
 *     resolved keystore (so a hardware-rooted backend can sign, and a hardware mandate is
 *     enforceable) — the same path as `kit policy sign`;
 *   - verify with the SAME trust order as `verifyPolicy`: an explicit `--key` pin → this
 *     machine's identity → the committed org trust anchor (`.kit-policy.signers`), with the
 *     same revocation semantics.
 *
 * `verifiedScope()` is the fail-closed hook for Pillar 3's exec-broker: it returns the scope
 * ONLY when the signature verifies. An unsigned or forged scope grants nothing.
 *
 * Zero new crypto — this is a second consumer of the verified floor.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { identityId, localPublicKeys, verifySignature, isRevokedWith } from "../identity.js";
import { policySignersMap, hasPolicyAnchor } from "../policy-trust.js";
import {
  resolveKeyStore,
  assertHardwareIdentity,
  isHardwareRooted,
  hardwareRequired,
} from "../keystore/index.js";
import type { PolicySignature } from "../policy-doc.js";
import { applySignedPairAtomically } from "../signed-file-pair.js";
import {
  loadProfile,
  serializeProfile,
  PROFILE_FILE,
  canonicalProfileBytes,
  profileDigest,
  profileFingerprint,
  type KitProfile,
  type ProfileScope,
} from "./schema.js";

export const PROFILE_SIG_FILE = ".kit-profile.sig";

interface ProfileSignatureRecord extends PolicySignature {
  enforcement?: { requestId: string; sig: string };
}

function enforcementRequestBytes(profile: KitProfile, requestId: string): string {
  return JSON.stringify(["kit.profile.enforcement", requestId, profileDigest(profile)]);
}

function verifiedEnforcementRequest(
  profile: KitProfile,
  proof: ProfileSignatureRecord["enforcement"],
  publicKey: string,
): string | undefined {
  if (typeof proof?.requestId !== "string" || typeof proof.sig !== "string") return undefined;
  const bytes = enforcementRequestBytes(profile, proof.requestId);
  return verifySignature(bytes, Buffer.from(proof.sig, "base64"), publicKey)
    ? proof.requestId
    : undefined;
}

function previousEnforcementProof(
  cwd: string,
  profile: KitProfile,
  publicKey: string,
): ProfileSignatureRecord["enforcement"] {
  try {
    const { enforcement } = JSON.parse(
      readFileSync(getProfileSigPath(cwd), "utf8"),
    ) as ProfileSignatureRecord;
    return verifiedEnforcementRequest(profile, enforcement, publicKey) ? enforcement : undefined;
  } catch {
    return undefined;
  }
}

export function getProfileSigPath(cwd: string): string {
  return resolve(cwd, PROFILE_SIG_FILE);
}

export interface ProfileSignResult {
  ok: boolean;
  error?: string;
  kid?: string;
  fingerprint?: string;
  rooted?: boolean;
}

interface ProfileReplacement {
  profile: KitProfile;
  expectedBytes: string;
  requestId: string;
}

async function publishReplacement(
  cwd: string,
  replacement: ProfileReplacement,
  record: ProfileSignatureRecord,
  signature: string,
): Promise<string | undefined> {
  const { profile, expectedBytes, requestId } = replacement;
  const verified = verifyProfileRecord(profile, record, cwd, {});
  if (verified.status !== "valid") return verified.detail;
  if (verified.enforcementRequestId !== requestId) {
    return "The enforcement request signature could not be verified.";
  }
  const current = await loadProfile(cwd);
  if (!current || canonicalProfileBytes(current) !== expectedBytes) {
    return "The profile changed during signing. Review it and retry.";
  }
  const result = applySignedPairAtomically(
    { document: resolve(cwd, PROFILE_FILE), signature: getProfileSigPath(cwd), kind: "profile" },
    Buffer.from(serializeProfile(profile)),
    Buffer.from(signature),
  );
  return result.ok ? undefined : result.detail;
}

/**
 * Sign the profile at `cwd`, writing `.kit-profile.sig`. Signs through the resolved keystore
 * (file / command / hardware) exactly like `kit policy sign`, and fails closed when a
 * hardware-rooted identity is mandated but the active backend isn't one.
 * If a replacement is supplied, prepare its signature before saving the profile.
 */
export async function signProfile(
  cwd = process.cwd(),
  replacement?: ProfileReplacement,
): Promise<ProfileSignResult> {
  const profile = replacement?.profile ?? (await loadProfile(cwd));
  if (!profile) return { ok: false, error: "no profile declared" };

  const res = resolveKeyStore();
  const pub = res.store.publicKeyPem();
  if (!pub) {
    return {
      ok: false,
      error: res.availability.ok
        ? "no identity to sign with — run kit identity init"
        : (res.availability.reason ?? "keystore unavailable"),
    };
  }
  try {
    assertHardwareIdentity(res, hardwareRequired(cwd));
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const kid = identityId(pub);
  const bytes = canonicalProfileBytes(profile);
  let sigB64: string;
  let enforcement: ProfileSignatureRecord["enforcement"];
  try {
    sigB64 = res.store.sign(bytes).toString("base64");
    if (replacement) {
      const { requestId } = replacement;
      const proof = res.store.sign(enforcementRequestBytes(profile, requestId));
      enforcement = { requestId, sig: proof.toString("base64") };
    }
  } catch (e) {
    return { ok: false, error: `signing failed: ${(e as Error).message}` };
  }
  if (!replacement) enforcement = previousEnforcementProof(cwd, profile, pub);
  const record: ProfileSignatureRecord = {
    kid,
    sig: sigB64,
    ts: new Date().toISOString(),
    fingerprint: profileFingerprint(profile),
    enforcement,
  };
  const signature = JSON.stringify(record, null, 2) + "\n";
  if (replacement) {
    const error = await publishReplacement(cwd, replacement, record, signature);
    if (error) return { ok: false, error };
  } else {
    writeFileSync(getProfileSigPath(cwd), signature, "utf-8");
  }
  return { ok: true, kid, fingerprint: record.fingerprint, rooted: isHardwareRooted(res) };
}

export type ProfileVerifyStatus = "valid" | "invalid" | "unsigned" | "unverifiable" | "revoked";

export interface ProfileVerifyResult {
  status: ProfileVerifyStatus;
  detail: string;
  kid?: string;
  fingerprint?: string;
  enforcementRequestId?: string;
  /** Where the verifying key came from. */
  via?: "key" | "local" | "org";
  /** True when a committed org trust anchor (.kit-policy.signers) is present. */
  anchored?: boolean;
}

/**
 * Verify `.kit-profile.sig` against the profile at `cwd`. Same trust order and revocation
 * semantics as `verifyPolicy` — fail-closed once an org anchor is present.
 */
export async function verifyProfileSignature(
  cwd = process.cwd(),
  opts: { key?: string } = {},
): Promise<ProfileVerifyResult> {
  const profile = await loadProfile(cwd);
  if (!profile) return { status: "unsigned", detail: "no profile declared" };

  let record: ProfileSignatureRecord;
  try {
    record = JSON.parse(readFileSync(getProfileSigPath(cwd), "utf-8")) as ProfileSignatureRecord;
  } catch {
    return { status: "unsigned", detail: `no ${PROFILE_SIG_FILE} (run kit profile sign)` };
  }
  return verifyProfileRecord(profile, record, cwd, opts);
}

function verifyProfileRecord(
  profile: KitProfile,
  record: ProfileSignatureRecord,
  cwd: string,
  opts: { key?: string },
): ProfileVerifyResult {
  let fingerprint: string;
  try {
    fingerprint = profileFingerprint(profile);
  } catch (e) {
    return {
      status: "invalid",
      detail: e instanceof Error ? e.message : "uncanonicalizable profile",
    };
  }

  const { pubkey, via } = findProfileSigner(cwd, record.kid, opts.key);
  const anchored = hasPolicyAnchor(cwd);
  if (!pubkey) {
    return {
      status: "unverifiable",
      detail: anchored
        ? `signer ${record.kid} is not in the org trust anchor (.kit-policy.signers)`
        : `signer ${record.kid} unknown (pin with --key, or add it to .kit-policy.signers)`,
      kid: record.kid,
      fingerprint,
      anchored,
    };
  }

  const fpMatches = record.fingerprint === fingerprint;
  const sigOk =
    fpMatches &&
    verifySignature(canonicalProfileBytes(profile), Buffer.from(record.sig, "base64"), pubkey);
  if (!sigOk) {
    return {
      status: "invalid",
      detail: fpMatches ? "signature mismatch" : "profile changed since signing — re-sign",
      kid: record.kid,
      fingerprint,
      via,
      anchored,
    };
  }

  // Revocation with the ORG trust context (self-revoke or an org-anchor signer may revoke;
  // the local machine root is deliberately not an authority) — identical to verifyPolicy.
  const orgSigners = policySignersMap(cwd);
  const trustedKeys = new Map<string, string>([...localPublicKeys(), ...orgSigners]);
  const authorities = new Set<string>(orgSigners.keys());
  if (isRevokedWith(record.kid, trustedKeys, authorities)) {
    return {
      status: "revoked",
      detail: `signer ${record.kid} is revoked`,
      kid: record.kid,
      fingerprint,
      via,
      anchored,
    };
  }

  return {
    status: "valid",
    detail: `signed by ${record.kid}${via === "org" ? " (org trust anchor)" : ""}`,
    kid: record.kid,
    fingerprint,
    enforcementRequestId: verifiedEnforcementRequest(profile, record.enforcement, pubkey),
    via,
    anchored,
  };
}

function findProfileSigner(
  cwd: string,
  kid: string,
  givenKey?: string,
): { pubkey?: string; via?: ProfileVerifyResult["via"] } {
  if (givenKey) {
    const pubkey = existsSync(givenKey) ? readFileSync(givenKey, "utf-8") : givenKey;
    return { pubkey, via: "key" };
  }
  const local = localPublicKeys().get(kid);
  if (local) return { pubkey: local, via: "local" };
  const org = policySignersMap(cwd).get(kid);
  return org ? { pubkey: org, via: "org" } : {};
}

/**
 * The fail-closed hook for Pillar 3's exec-broker: the profile's `[scope]` — but ONLY when the
 * profile carries a VALID signature. An unsigned, changed, forged, or revoked-signer scope
 * returns `null` (grants nothing). A profile with no `[scope]` also returns `null`.
 */
export async function verifiedScope(
  cwd = process.cwd(),
  opts: { key?: string } = {},
): Promise<ProfileScope | null> {
  const profile = await loadProfile(cwd);
  if (!profile?.scope) return null;
  const v = await verifyProfileSignature(cwd, opts);
  return v.status === "valid" ? profile.scope : null;
}
