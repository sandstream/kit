/**
 * Agent-write pre-approval policy.
 *
 * `.kit.toml [policy.agent_writes]` declares which sensitive vendor
 * operations the operator pre-authorizes for this repository. Classifiers
 * and agents read a stable hash of the policy via `KIT_POLICY_HASH` so
 * the in-scope ops can run without per-call human confirmation, while
 * out-of-scope ops still require explicit elevation.
 *
 * Format in .kit.toml:
 *
 *   [policy.agent_writes]
 *   sentry = ["resolve_issue", "create_release"]
 *   supabase = ["rotate_jwt", "list_projects"]
 *   vercel = ["env_set", "trigger_deploy"]
 *   stripe = []        # all writes still gated
 *
 *   [policy]
 *   default_mode = "read-only"   # force --read-only globally for this repo
 *
 * Runtime contract:
 *   1. At boot, the orchestrator (cli.ts:main) reads `[policy]` from the
 *      loaded config, computes a SHA-256 of the canonical JSON, exports
 *      `KIT_POLICY_HASH=<hex>` to env so child processes / classifiers
 *      see the same identity.
 *   2. Callers that mutate vendor state call `checkPolicy(vendor, op)` —
 *      returns true if the op appears in `agent_writes[vendor]`. False
 *      means the op is gated and requires elevation.
 *   3. Every policy check emits an audit event with `policy_scope_matched`
 *      so the forensic trail covers both grants and denials.
 *
 * This module deliberately does NOT enforce — it just SURFACES. The
 * existing elevation + read-only gates remain authoritative; the policy
 * block is the explicit "operator agreed to this scope" signal that
 * upstream classifiers (Claude Code, etc.) can honor.
 */

import { createHash } from "node:crypto";
import type { PolicyConfig } from "./config.js";
import { appendAuditEventDirect } from "./audit.js";

const POLICY_HASH_ENV = "KIT_POLICY_HASH";

/**
 * Canonical JSON for hashing — sorted keys at every level so the hash is
 * stable across reorderings in `.kit.toml`.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

export function hashPolicy(policy: PolicyConfig | undefined): string | null {
  if (!policy) return null;
  return createHash("sha256").update(canonicalize(policy)).digest("hex");
}

/**
 * Computes the policy hash and exports it to env. Called once from main()
 * after config is loaded. Idempotent.
 */
export function installPolicyHash(policy: PolicyConfig | undefined): void {
  const hash = hashPolicy(policy);
  if (hash) {
    process.env[POLICY_HASH_ENV] = hash;
  } else {
    delete process.env[POLICY_HASH_ENV];
  }
}

export function currentPolicyHash(): string | null {
  return process.env[POLICY_HASH_ENV] ?? null;
}

export interface PolicyCheckResult {
  /** True when the (vendor, op) pair is explicitly pre-authorized. */
  approved: boolean;
  /** Reason / detail for diagnostics. */
  reason: string;
  /** Policy hash at the time of check, for audit-log correlation. */
  policyHash: string | null;
}

/**
 * Check whether `op` against `vendor` is pre-approved by the policy.
 *
 * Returns `{ approved: false }` when the policy is missing, the vendor
 * isn't declared, or the op isn't in the vendor's allow-list. Callers
 * should treat false as "elevation still required" — this is not a
 * substitute for the elevation gate, just an explicit declaration that
 * the OPERATOR consented to this scope at configuration time.
 */
export async function checkPolicy(
  policy: PolicyConfig | undefined,
  vendor: string,
  op: string,
): Promise<PolicyCheckResult> {
  const policyHash = hashPolicy(policy);
  if (!policy?.agent_writes) {
    const result: PolicyCheckResult = {
      approved: false,
      reason: "no [policy.agent_writes] declared in .kit.toml",
      policyHash,
    };
    await appendAuditEventDirect({
      operation: "policy-check",
      environment: process.env.KIT_ENV ?? process.env.NODE_ENV ?? "unknown",
      success: false,
      metadata: { vendor, op, policy_hash: policyHash, reason: result.reason },
    });
    return result;
  }
  const allowed = policy.agent_writes[vendor];
  if (!allowed) {
    const result: PolicyCheckResult = {
      approved: false,
      reason: `vendor "${vendor}" not in [policy.agent_writes]`,
      policyHash,
    };
    await appendAuditEventDirect({
      operation: "policy-check",
      environment: process.env.KIT_ENV ?? process.env.NODE_ENV ?? "unknown",
      success: false,
      metadata: { vendor, op, policy_hash: policyHash, reason: result.reason },
    });
    return result;
  }
  if (!allowed.includes(op)) {
    const result: PolicyCheckResult = {
      approved: false,
      reason: `op "${op}" not in [policy.agent_writes.${vendor}] (= ${JSON.stringify(allowed)})`,
      policyHash,
    };
    await appendAuditEventDirect({
      operation: "policy-check",
      environment: process.env.KIT_ENV ?? process.env.NODE_ENV ?? "unknown",
      success: false,
      metadata: {
        vendor,
        op,
        policy_hash: policyHash,
        allowed_ops: allowed,
        reason: result.reason,
      },
    });
    return result;
  }
  const result: PolicyCheckResult = {
    approved: true,
    reason: `op "${op}" approved by [policy.agent_writes.${vendor}]`,
    policyHash,
  };
  await appendAuditEventDirect({
    operation: "policy-check",
    environment: process.env.KIT_ENV ?? process.env.NODE_ENV ?? "unknown",
    success: true,
    metadata: {
      vendor,
      op,
      policy_hash: policyHash,
    },
  });
  return result;
}

/**
 * Test-only: reset env var so tests start fresh.
 */
export function _resetPolicyHashForTests(): void {
  delete process.env[POLICY_HASH_ENV];
}
