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
 *   2. ENFORCED, by `policy-gate.ts` rather than this module. `enforcePolicy()` there is the
 *      enforcement point: it decides via the pure `policyDecision`, records the decision, and
 *      returns only a REFUSAL — because this block is unsigned config, so it may narrow and never
 *      grant. An agent that can edit `.kit.toml` must not be able to self-approve by adding a line.
 *      First enforcement point: `secrets-propagate.ts`, gating all six vendor `env_set` writes at
 *      the single choke point rather than per call site.
 *      Verify what is actually wired, rather than trusting this comment:
 *        grep -rn 'enforcePolicy(' src --include=*.ts | grep -v test
 *   3. Every ENFORCED decision emits a `policy-check` audit event carrying the vendor, op,
 *      `policy_state` and policy hash, in the GOVERNED project's log — so the trail covers grants
 *      as well as refusals. `inert` and `unconfigured` write nothing on purpose: they are the
 *      absence of a policy opinion, and recording them would put a line in every repo that does
 *      not use the block and bury the two states that carry information.
 *      Not fail-closed on the append, deliberately — a refusal has already stopped the operation
 *      and an approval grants nothing, so a failed write cannot change an outcome, only lose a
 *      record. The failure goes to stderr rather than being swallowed.
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
/**
 * Check whether `op` against `vendor` is pre-approved, and audit the check.
 *
 * The DECISION is delegated to `policyDecision` in `policy-gate.ts` — there must be exactly one
 * function answering this access question. Two independent implementations of the same rule is the
 * divergence class that let `kit_fix`'s MCP handler keep a stale copy of the lock step: both looked
 * right in isolation and only one was fixed.
 *
 * `approved: false` means "policy does not pre-approve" and covers three different states —
 * `inert`, `unconfigured` and `denied`. Callers that need to tell "unconfigured" from
 * "configured to refuse" apart MUST use `policyDecision`/`enforcePolicy` instead; that distinction
 * is why the gate returns a four-state union and this function's boolean cannot carry it.
 *
 * Pre-approval is not a grant. See the semantics section in `policy-gate.ts`.
 */
export async function checkPolicy(
  policy: PolicyConfig | undefined,
  vendor: string,
  op: string,
): Promise<PolicyCheckResult> {
  const { policyDecision } = await import("./policy-gate.js");
  const decision = policyDecision(policy, vendor, op);
  const policyHash = hashPolicy(policy);
  const result: PolicyCheckResult = {
    approved: decision.state === "approved",
    reason: decision.reason,
    policyHash,
  };
  await appendAuditEventDirect({
    operation: "policy-check",
    environment: process.env.KIT_ENV ?? process.env.NODE_ENV ?? "unknown",
    success: result.approved,
    metadata: {
      vendor,
      op,
      policy_state: decision.state,
      policy_hash: policyHash,
      reason: decision.reason,
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
