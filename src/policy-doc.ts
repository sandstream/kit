/**
 * kit policy document — signable, distributable policy-as-code (3.0 Phase 1).
 *
 * 2.x expresses standards implicitly (hard-coded thresholds, per-scanner config).
 * 3.0's model-change is that the STANDARD becomes a first-class, SIGNABLE document
 * an org owns — separate from per-project config — that an identity (Phase 0) can
 * sign and any kit can verify offline before enforcing. "identity + policy = the
 * contract": the pair that earns the major bump.
 *
 * Distinct from the 2.x agent-write pre-approval in `src/policy.ts`
 * (`.kit.toml [policy.agent_writes]`): that is per-repo "which vendor ops are
 * pre-authorized"; THIS is the org-level standard (thresholds / requirements),
 * versioned and signed independently of project config.
 *
 * WHY A SEPARATE FILE (`.kit-policy.toml`):
 *  - distribution: one org policy, signed once, dropped into many repos;
 *  - stable signatures: a canonical doc that only moves when policy changes —
 *    not on every unrelated `.kit.toml` edit;
 *  - separation of duties: owned by security/governance, not the developer;
 *  - frozen-contract safety: `.kit.toml` is a frozen 2.x contract.
 *
 * Signing is over CANONICAL JSON (recursively key-sorted) of the parsed document,
 * so a signature survives TOML reformatting / comments / key reorder and breaks
 * only on a real policy change. Local-first, deterministic, zero-LLM.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { localPublicKeys, verifySignature, isRevokedWith } from "./identity.js";
import { policySignersMap, hasPolicyAnchor } from "./policy-trust.js";

export const POLICY_FILE = ".kit-policy.toml";
export const POLICY_SIG_FILE = ".kit-policy.sig";
/** Schema version this kit understands. A doc declaring a higher version is refused (upgrade kit). */
export const POLICY_SCHEMA_VERSION = 1;

export interface PolicyThresholds {
  /** Minimum CodeScene code-health score (see #45). */
  code_health?: number;
  [key: string]: number | undefined;
}

export interface PolicyDoc {
  /** Schema version (integer). Required. */
  version: number;
  /** No untriaged installs (the install-gate must be on). */
  require_triage?: boolean;
  /** Scanners that MUST run (a missing/errored one fails the gate). */
  required_scanners?: string[];
  /** Prod writes require an approval. */
  prod_writes_need_approval?: boolean;
  /** Minimum kit version this policy expects. */
  min_kit_version?: string;
  /**
   * Mandate a hardware/externally-held signing identity fleet-wide: when true, kit refuses
   * to sign audit/memory/policy/revocation artifacts with the same-UID-readable file key
   * (same effect as KIT_REQUIRE_HARDWARE_IDENTITY). Tightening-only — it can add the
   * mandate but a `false`/absent value never RELAXES an environment mandate.
   */
  require_hardware_identity?: boolean;
  /** Numeric thresholds (e.g. code_health). */
  thresholds?: PolicyThresholds;
}

export function getPolicyPath(root: string): string {
  return join(root, POLICY_FILE);
}
export function getPolicySigPath(root: string): string {
  return join(root, POLICY_SIG_FILE);
}

/** Parse `.kit-policy.toml`. Returns null when absent/unparseable (caller decides). */
export function loadPolicy(root: string): PolicyDoc | null {
  try {
    return parse(readFileSync(getPolicyPath(root), "utf8")) as unknown as PolicyDoc;
  } catch {
    return null;
  }
}

export interface PolicyValidation {
  ok: boolean;
  errors: string[];
}

/** Validate a parsed policy against the allow-listed schema. Pure. */
export function validatePolicy(doc: unknown): PolicyValidation {
  const errors: string[] = [];
  if (typeof doc !== "object" || doc === null) {
    return { ok: false, errors: ["policy is not a TOML table"] };
  }
  const d = doc as Record<string, unknown>;
  // Refuse prototype-manipulating keys outright — they have no place in a policy
  // and a `__proto__` table is exactly what the canonical-bytes hardening guards
  // against (see sortDeep). Defense-in-depth: reject at the schema layer too.
  for (const k of ["__proto__", "constructor", "prototype"]) {
    if (Object.prototype.hasOwnProperty.call(d, k)) errors.push(`forbidden key \`${k}\``);
  }
  if (d.version === undefined) {
    errors.push("missing required `version`");
  } else if (typeof d.version !== "number" || !Number.isInteger(d.version)) {
    errors.push("`version` must be an integer");
  } else if (d.version > POLICY_SCHEMA_VERSION) {
    errors.push(
      `policy version ${d.version} is newer than this kit supports (${POLICY_SCHEMA_VERSION}) — upgrade kit`,
    );
  }
  const bool = (k: string) => {
    if (d[k] !== undefined && typeof d[k] !== "boolean") errors.push(`\`${k}\` must be a boolean`);
  };
  bool("require_triage");
  bool("prod_writes_need_approval");
  bool("require_hardware_identity");
  if (
    d.required_scanners !== undefined &&
    (!Array.isArray(d.required_scanners) || d.required_scanners.some((s) => typeof s !== "string"))
  ) {
    errors.push("`required_scanners` must be an array of strings");
  }
  if (d.min_kit_version !== undefined && typeof d.min_kit_version !== "string") {
    errors.push("`min_kit_version` must be a string");
  }
  if (d.thresholds !== undefined) {
    if (typeof d.thresholds !== "object" || d.thresholds === null) {
      errors.push("`thresholds` must be a table");
    } else {
      for (const [k, v] of Object.entries(d.thresholds as Record<string, unknown>)) {
        if (typeof v !== "number") errors.push(`\`thresholds.${k}\` must be a number`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  // A non-plain object (Date, bigint via typeof, etc.) has no faithful canonical
  // JSON form: a TOML date and the equivalent string would serialize to identical
  // bytes, so two semantically different policies could share one signature. Refuse
  // it — the document must be plain string/number/boolean/array/table.
  if (v instanceof Date) {
    throw new Error("policy contains a date value; use a quoted string instead");
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const value = sortDeep((v as Record<string, unknown>)[k]);
      // Assign via defineProperty so a `__proto__` (or `constructor`) key becomes a
      // real OWN, enumerable property included in the canonical bytes. A plain
      // `out[k] = …` would treat `out["__proto__"] = …` as a prototype write and
      // silently DROP the key+subtree — letting an attacker append a `[__proto__]`
      // table to a signed policy without changing its signing bytes.
      Object.defineProperty(out, k, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return v;
}

/**
 * Canonical signing bytes: JSON of the recursively key-sorted document. Stable
 * across TOML reformatting / comment edits / key reordering — only a real policy
 * change moves the bytes (and thus invalidates a signature). Throws on a document
 * that has no faithful canonical form (e.g. a TOML date value).
 */
export function canonicalPolicyBytes(doc: unknown): string {
  return JSON.stringify(sortDeep(doc));
}

/** Short content fingerprint of a policy (for display / pinning). */
export function policyFingerprint(doc: unknown): string {
  return (
    "sha256:" + createHash("sha256").update(canonicalPolicyBytes(doc)).digest("hex").slice(0, 16)
  );
}

/** Detached signature record written to `.kit-policy.sig`. */
export interface PolicySignature {
  kid: string;
  sig: string;
  ts: string;
  fingerprint: string;
}

export type PolicyVerifyStatus = "valid" | "invalid" | "unsigned" | "unverifiable" | "revoked";

export interface PolicyVerifyResult {
  status: PolicyVerifyStatus;
  detail: string;
  kid?: string;
  fingerprint?: string;
  /** Where the verifying key came from: a pinned --key, the local identity, or the org trust anchor. */
  via?: "key" | "local" | "org";
  /** True when a committed org trust anchor (.kit-policy.signers) is present. */
  anchored?: boolean;
}

/**
 * Verify the signature on the policy at `root`. Pure-ish (file reads, no writes).
 * Shared by `kit policy verify` and `kit policy check` so they cannot diverge.
 *   - valid: fingerprint matches + signature verifies + signer not revoked.
 *   - invalid: doc changed since signing, or a bad signature (a forge).
 *   - unsigned: no .kit-policy.sig.
 *   - unverifiable: signer key unknown locally (pin with `key`) — trust-absence, not a forge.
 *   - revoked: signature verifies but the signer key was revoked (kit panic).
 */
export function verifyPolicy(root: string, opts: { key?: string } = {}): PolicyVerifyResult {
  const doc = loadPolicy(root);
  if (!doc) return { status: "unsigned", detail: "no policy document" };
  let record: PolicySignature;
  try {
    record = JSON.parse(readFileSync(getPolicySigPath(root), "utf-8")) as PolicySignature;
  } catch {
    return { status: "unsigned", detail: "no .kit-policy.sig (run kit policy sign)" };
  }
  let fingerprint: string;
  try {
    fingerprint = policyFingerprint(doc);
  } catch (e) {
    // Document has no faithful canonical form (e.g. a date value) — it can't be
    // soundly signed or verified. Treat as invalid, never crash the gate.
    return {
      status: "invalid",
      detail: e instanceof Error ? e.message : "uncanonicalizable policy",
    };
  }
  const anchored = hasPolicyAnchor(root);
  // Resolve the signer key, in trust order: an explicit --key pin, then this
  // machine's own identity (the author verifying their own policy), then the
  // committed org trust anchor (.kit-policy.signers) — which is what makes an
  // ORG-distributed policy verify on a fresh clone.
  let pubkey: string | null = null;
  let via: PolicyVerifyResult["via"] = undefined;
  if (opts.key) {
    pubkey = existsSync(opts.key) ? readFileSync(opts.key, "utf-8") : opts.key;
    via = "key";
  } else if (localPublicKeys().get(record.kid)) {
    pubkey = localPublicKeys().get(record.kid)!;
    via = "local";
  } else if (policySignersMap(root).get(record.kid)) {
    pubkey = policySignersMap(root).get(record.kid)!;
    via = "org";
  }
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
    verifySignature(canonicalPolicyBytes(doc), Buffer.from(record.sig, "base64"), pubkey);
  if (!sigOk) {
    return {
      status: "invalid",
      detail: fpMatches ? "signature mismatch" : "policy changed since signing — re-sign",
      kid: record.kid,
      fingerprint,
      via,
      anchored,
    };
  }
  // Revocation check with the ORG trust context: a revocation of the policy signer is
  // honored only if it is validly signed by an AUTHORIZED revoker — the signer ITSELF
  // (self-revoke, via by===kid inside isRevokedWith) or an ORG trust-anchor signer.
  // The local machine root is deliberately NOT an authority here: who may revoke the
  // org's trust anchor is an ORG decision, not something a single machine's key gets to
  // veto. (Local root remains the authority for the LOCAL secondary deny in rbac/isRevoked.)
  // This also stops a planted/unauthorized revocation line from falsely reporting the
  // org's real signer as revoked (a fail-closed DoS on the trust anchor).
  const orgSigners = policySignersMap(root);
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
    via,
    anchored,
  };
}

/** A ready-to-edit starter policy (written by `kit policy init`). */
export const POLICY_TEMPLATE = `# kit policy — the org standard, signed and verified independently of project config.
# Sign with:  kit policy sign      Verify with:  kit policy verify
version = ${POLICY_SCHEMA_VERSION}

# No untriaged dependency installs (the install-gate must be on).
require_triage = true

# Scanners that MUST run — a missing or errored one fails the gate.
# required_scanners = ["trivy", "trufflehog"]

# Prod writes require an approval.
# prod_writes_need_approval = true

# Minimum kit version this policy expects.
# min_kit_version = "2.2.0"

# [thresholds]
# code_health = 7.5
`;
