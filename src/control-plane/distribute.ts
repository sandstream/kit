/**
 * kit control plane — Pelare 2: signed-policy distribution + revocation propagation.
 *
 * The control plane is a VERIFIER and DISTRIBUTOR of signed artifacts, NOT a
 * runtime-dependent service. Everything here holds the north-star invariants:
 *   - local-first / air-gap: a bundle can be a plain FILE; the only network is the
 *     opt-in `https:` fetch, behind an injectable `fetchImpl` (so tests + air-gap
 *     runs touch zero network). No egress by default, no telemetry.
 *   - verification is OFFLINE + deterministic: a transported policy is verified
 *     against the repo's committed `.kit-policy.signers` trust anchor, reusing the
 *     EXACT `verifyPolicy` codepath (no crypto re-implementation) by seeding a temp
 *     dir with the transported policy + the local anchor.
 *   - FAIL-CLOSED / no false-green: apply happens ONLY when the policy verdict is
 *     `valid`; every revocation is signature-checked against the anchor before it
 *     is merged; anything unverifiable is rejected, never applied.
 *   - zero LLM.
 *
 * A `PolicyBundle` carries the RAW policy bytes (the `.kit-policy.toml` text) and
 * the raw `.kit-policy.sig` JSON — not a parsed doc — so transport is lossless and
 * verification can reuse the on-disk codepath byte-for-byte.
 */
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyPolicy,
  getPolicyPath,
  getPolicySigPath,
  loadPolicy,
  parsePolicyToml,
  policyFingerprint,
  type PolicyVerifyResult,
} from "./../policy-doc.js";
import { getSignersPath, policySignersMap } from "./../policy-trust.js";
import {
  verifySignature,
  revocationStatement,
  appendRevocations,
  type RevocationRecord,
} from "./../identity.js";

/** A transportable, org-signed policy artifact (+ optional revocation batch). */
export interface PolicyBundle {
  /** Raw `.kit-policy.toml` text. */
  policyToml: string;
  /** Raw `.kit-policy.sig` JSON text (the PolicySignature record). */
  policySig: string;
  /** Signed revocation records to propagate (each verified before merge). */
  revocations?: RevocationRecord[];
}

/** Upper bound on a remotely-fetched bundle. Real bundles are a few KB; this caps a hostile
 *  endpoint's response without touching the local-file (air-gap) path. */
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

/** Type guard: a parsed value is a well-formed PolicyBundle. Fail-closed. */
export function isPolicyBundle(v: unknown): v is PolicyBundle {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  if (typeof b.policyToml !== "string" || typeof b.policySig !== "string") return false;
  if (b.revocations !== undefined && !Array.isArray(b.revocations)) return false;
  return true;
}

export interface BundleVerifyResult {
  /** Overall: true only when the policy verdict is `valid` AND every revocation verified. */
  ok: boolean;
  /** The reused verifyPolicy verdict for the transported policy. */
  policy: PolicyVerifyResult;
  /** Revocation records whose signature verified against the org trust anchor. */
  verifiedRevocations: RevocationRecord[];
  /** Human reason when !ok. */
  reason?: string;
}

/**
 * Verify a bundle against the repo's committed trust anchor at `root`, fully
 * offline. Reuses `verifyPolicy` by seeding a temp dir with the transported
 * policy + a COPY of the local `.kit-policy.signers`, so the exact on-disk
 * verification path runs (no re-implemented crypto). Never writes to `root`.
 */
export function verifyPolicyBundle(bundle: PolicyBundle, root: string): BundleVerifyResult {
  const signersMap = policySignersMap(root);
  const tmp = mkdtempSync(join(tmpdir(), "kit-cp-verify-"));
  try {
    writeFileSync(getPolicyPath(tmp), bundle.policyToml, "utf-8");
    writeFileSync(getPolicySigPath(tmp), bundle.policySig, "utf-8");
    // Seed a COPY of the local anchor so verifyPolicy sees `anchored:true` for the
    // temp repo; the actual trust decision is the explicit org-key PIN below (the
    // bundle's own bytes can never vouch for it).
    const localSigners = getSignersPath(root);
    if (existsSync(localSigners)) copyFileSync(localSigners, getSignersPath(tmp));

    // Force ORG-ANCHOR-ONLY trust. verifyPolicy resolves a signer as
    // --key → localPublicKeys() → org anchor; the middle branch reads the VERIFYING
    // machine's own identity, which would accept a self-signed bundle no org key ever
    // signed. Distribution must trust ONLY the committed anchor, so resolve the sig's
    // kid against OUR anchor here and PIN it (→ verifyPolicy takes the "key" path and
    // never consults localPublicKeys). No org key for the kid → reject (fail-closed).
    let sigKid: string | undefined;
    try {
      sigKid = (JSON.parse(bundle.policySig) as { kid?: string }).kid;
    } catch {
      sigKid = undefined;
    }
    const orgKey = typeof sigKid === "string" ? signersMap.get(sigKid) : undefined;
    if (!orgKey) {
      return {
        ok: false,
        policy: {
          status: "unverifiable",
          detail: "policy signer is not in the org trust anchor",
          kid: sigKid,
        },
        verifiedRevocations: [],
        reason: `policy signer ${sigKid ?? "(unknown)"} is not in the org trust anchor`,
      };
    }

    const policy = verifyPolicy(tmp, { key: orgKey });
    if (policy.status !== "valid") {
      return {
        ok: false,
        policy,
        verifiedRevocations: [],
        reason: `policy not valid: ${policy.status} — ${policy.detail}`,
      };
    }

    const rev = verifyRevocationBatch(bundle.revocations ?? [], signersMap);
    if (!rev.ok) return { ok: false, policy, verifiedRevocations: [], reason: rev.reason };
    return { ok: true, policy, verifiedRevocations: rev.verified };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Signature-check a batch of revocations against the org trust anchor: each `by`
 * must be a trusted org signer and its signature must cover the canonical
 * `(kid, ts, reason)` statement. Fail-closed — the FIRST bad record rejects the
 * whole batch (an org bundle is all-or-nothing; a partial merge could drop a
 * revocation the org intended).
 */
function verifyRevocationBatch(
  revocations: RevocationRecord[],
  signersMap: Map<string, string>,
): { ok: boolean; verified: RevocationRecord[]; reason?: string } {
  const verified: RevocationRecord[] = [];
  for (const rec of revocations) {
    if (
      typeof rec?.kid !== "string" ||
      typeof rec?.ts !== "string" ||
      typeof rec?.reason !== "string" ||
      typeof rec?.by !== "string" ||
      typeof rec?.sig !== "string"
    ) {
      return { ok: false, verified: [], reason: "malformed revocation record" };
    }
    const signerKey = signersMap.get(rec.by);
    if (!signerKey) {
      return {
        ok: false,
        verified: [],
        reason: `revocation signed by ${rec.by}, not in the org trust anchor`,
      };
    }
    let sigOk = false;
    try {
      sigOk = verifySignature(
        revocationStatement(rec.kid, rec.ts, rec.reason),
        Buffer.from(rec.sig, "base64"),
        signerKey,
      );
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return {
        ok: false,
        verified: [],
        reason: `revocation for ${rec.kid} has an invalid signature`,
      };
    }
    verified.push(rec);
  }
  return { ok: true, verified };
}

export interface ApplyResult {
  applied: boolean;
  fingerprint?: string;
  revocationsAdded: number;
  reason?: string;
}

/**
 * Verify a bundle, then — ONLY if valid — write the policy + signature into `root`
 * and merge the verified revocations into the local append-only log. Fail-closed:
 * an unverifiable bundle is never applied and `root` is left untouched.
 * `identityDir` overrides where revocations are merged (testability).
 */
export function applyPolicyBundle(
  bundle: PolicyBundle,
  root: string,
  opts: { identityDir?: string } = {},
): ApplyResult {
  const verdict = verifyPolicyBundle(bundle, root);
  if (!verdict.ok) return { applied: false, revocationsAdded: 0, reason: verdict.reason };

  // Monotonic-revision ratchet: reject a validly-signed bundle that would ROLL BACK the
  // applied policy. The org signs each `revision` (it's in the canonical signed bytes, so it
  // can't be forged over the transport); an attacker who REPLAYS a genuinely-signed older
  // bundle carries an older (or absent) revision. Once the applied policy declares a revision,
  // an incoming bundle must declare a strictly-greater one (equal only for the byte-identical
  // policy — idempotent re-sync). A fleet that never sets `revision` keeps today's behavior.
  //
  // The floor is trusted ONLY if the on-disk policy itself VERIFIES against the org anchor —
  // an unsigned/tampered local file must not set the floor, else a planted high `revision`
  // would freeze all legit updates (fail-closed DoS). (A local attacker who DELETES the policy
  // can still reset the floor; fully closing that needs a persistent tamper-evident high-water
  // mark — tracked separately. Enforcement fails closed on any policy they can't org-sign.)
  const current = loadPolicy(root);
  const floor =
    current?.revision !== undefined && verifyPolicy(root).status === "valid"
      ? current.revision
      : undefined;
  if (floor !== undefined) {
    const incoming = parsePolicyToml(bundle.policyToml);
    const incomingRev = incoming?.revision;
    const rollback =
      incomingRev === undefined ||
      incomingRev < floor ||
      (incomingRev === floor && verdict.policy.fingerprint !== policyFingerprint(current));
    if (rollback) {
      return {
        applied: false,
        revocationsAdded: 0,
        reason: `policy revision ${incomingRev ?? "(absent)"} does not advance the applied revision ${floor} — refusing rollback`,
      };
    }
  }

  writeFileSync(getPolicyPath(root), bundle.policyToml, "utf-8");
  writeFileSync(getPolicySigPath(root), bundle.policySig, "utf-8");
  const revocationsAdded = appendRevocations(verdict.verifiedRevocations, opts.identityDir);
  return {
    applied: true,
    fingerprint: verdict.policy.fingerprint,
    revocationsAdded,
  };
}

/**
 * Fetch a bundle from a source. A local file path (or `file:` URL) is read
 * synchronously and works fully air-gapped; an `http(s):` URL is fetched via the
 * injectable `fetchImpl` (opt-in network — subject to kit's egress policy). Parsed
 * + shape-validated; fail-closed on a non-OK response or a malformed bundle.
 */
export async function fetchPolicyBundle(
  source: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<PolicyBundle> {
  let raw: string;
  if (/^https?:\/\//.test(source)) {
    const doFetch = opts.fetchImpl ?? fetch;
    // Bounded fetch: a 15s timeout so a hung/slow endpoint can't stall indefinitely, and a
    // size cap so a hostile endpoint can't stream an unbounded body. A real bundle is a few KB.
    const res = await doFetch(source, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`policy bundle fetch failed: HTTP ${res.status}`);
    const declared = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BUNDLE_BYTES) {
      throw new Error(`policy bundle too large: ${declared} bytes (max ${MAX_BUNDLE_BYTES})`);
    }
    raw = await res.text();
    if (raw.length > MAX_BUNDLE_BYTES) {
      throw new Error(`policy bundle too large: ${raw.length} bytes (max ${MAX_BUNDLE_BYTES})`);
    }
  } else {
    const path = source.startsWith("file:") ? new URL(source).pathname : source;
    raw = readFileSync(path, "utf-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("policy bundle is not valid JSON");
  }
  if (!isPolicyBundle(parsed)) throw new Error("policy bundle is malformed");
  return parsed;
}
