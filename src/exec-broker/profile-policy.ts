/**
 * kit exec-broker — the SIGNED policy source (reconciliation R2).
 *
 * Design: `kit-research/docs/research/pillar3-broker-reconciliation-5.0.md`.
 *
 * The exec-broker's original policy source is an UNSIGNED `.kit-exec-broker.json` (`policy.ts`).
 * This bridges the SIGNED, offline-verified profile scope (`[scope]`/RoE from Pillar 4) into a
 * `BrokerPolicy`, so the one canonical broker can be driven by a cryptographically attributable
 * source. It is the shared signed provider for the PreToolUse gates (R3) and `kit doctor`.
 *
 * Fail-closed, mirroring the profile's own semantics:
 *   - no profile / no `[scope]` declared  → regime "none" (no RoE to enforce; caller decides
 *     whether to fall back to the JSON policy or run unmediated — this module imposes nothing);
 *   - `[scope]` declared + signature VERIFIED → regime "active" with a BrokerPolicy that governs;
 *   - `[scope]` declared but unsigned / tampered / revoked → regime "active" with policy `null`
 *     (declaring a scope is the opt-in; only a verified one grants — a null policy default-denies
 *     in `brokerExec`).
 *
 * Deterministic, zero-LLM, local-only (file reads + offline signature verify). Never throws.
 */
import { resolve } from "node:path";
import { loadProfile } from "../profile/schema.js";
import { verifyProfileSignature } from "../profile/sign.js";
import type { BrokerPolicy } from "./policy.js";

export interface ProfilePolicyResult {
  /** "none" = no RoE declared; "active" = a `[scope]` is declared (policy set iff verified). */
  regime: "none" | "active";
  /** The governing policy — non-null ONLY when regime is "active" AND the signature verified. */
  policy: BrokerPolicy | null;
  detail: string;
}

/** Map a verified profile `[scope]` onto a BrokerPolicy (fs paths resolved against `cwd`). */
function scopeToPolicy(
  scope: { egress?: string[]; fs?: string[]; secrets?: string[] },
  cwd: string,
): BrokerPolicy {
  const roots = (scope.fs && scope.fs.length > 0 ? scope.fs : ["."]).map((p) => resolve(cwd, p));
  return {
    egress: { allow: scope.egress ? [...scope.egress] : [] },
    fs: roots.length > 1 ? { root: roots[0], roots: roots.slice(1) } : { root: roots[0] },
    env: { declared: scope.secrets ? [...scope.secrets] : [] },
  };
}

/**
 * Resolve the signed profile scope into a broker-policy regime. Never throws — a malformed
 * profile surfaces as regime "active" with a null policy (fail-closed), never as "none".
 */
export async function profileBrokerPolicy(cwd = process.cwd()): Promise<ProfilePolicyResult> {
  let scope: { egress?: string[]; fs?: string[]; secrets?: string[] } | undefined;
  try {
    const profile = await loadProfile(cwd);
    if (!profile) return { regime: "none", policy: null, detail: "no profile declared" };
    scope = profile.scope;
  } catch (err) {
    // A profile exists but is malformed — a declared-but-broken RoE. Treat as active+deny, never
    // "none" (a broken artifact must not silently disable enforcement).
    return {
      regime: "active",
      policy: null,
      detail: `profile unreadable — ${err instanceof Error ? err.message : String(err)} (default-deny)`,
    };
  }
  if (!scope) return { regime: "none", policy: null, detail: "profile declares no [scope]/RoE" };

  const v = await verifyProfileSignature(cwd);
  if (v.status === "valid") {
    return {
      regime: "active",
      policy: scopeToPolicy(scope, cwd),
      detail: `scope verified (${v.detail})`,
    };
  }
  return {
    regime: "active",
    policy: null,
    detail: `scope declared but ${v.status} — ${v.detail}; grants nothing (fail-closed)`,
  };
}
