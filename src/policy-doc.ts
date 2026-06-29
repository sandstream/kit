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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";

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
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * Canonical signing bytes: JSON of the recursively key-sorted document. Stable
 * across TOML reformatting / comment edits / key reordering — only a real policy
 * change moves the bytes (and thus invalidates a signature).
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
