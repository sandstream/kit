/**
 * kit exec-broker — declared operation needs vs the signed scope, for the governance floor.
 *
 * Design: `pillar3-exec-broker-5.0.md` §3.4 / §6.4, unified onto the canonical exec-broker per
 * `pillar3-broker-reconciliation-5.0.md` (R4). An operation running under `withGovernance`
 * DECLARES what it is about to touch — hosts, write paths, secret env keys — and this module
 * answers whether the signed `[scope]`/RoE grants it. It is the governance-floor counterpart to
 * the PreToolUse gates: both read the SAME signed source (`profileBrokerPolicy`) and use the
 * SAME pure decisions (`decisions.ts`), so there is one broker, not two.
 *
 * Opt-in semantics, mirrored from the PreToolUse gates but adapted to a floor that runs for
 * EVERY governed op:
 *   - no scope regime declared at all (regime "none") → nothing to enforce; advisory floor
 *     unchanged (backward compatible — projects without a profile see no behavior change);
 *   - a scope IS declared but unsigned/tampered/malformed (regime "active", policy null) → the
 *     regime exists but is not trustworthy: declared needs are DENIED (fail-closed — declaring a
 *     scope is the opt-in, and only a verified one grants);
 *   - verified (regime "active", policy set) → each declared need must be inside the scope.
 *
 * Deterministic, zero-LLM, local-only.
 */
import { resolve } from "node:path";
import { profileBrokerPolicy } from "./profile-policy.js";
import { checkEgress, checkFsWrite } from "./decisions.js";
import { policyFsRoots } from "./policy.js";

/** What a governed operation declares it is about to touch. All fields optional/additive. */
export interface ScopeNeeds {
  /** Hosts the operation will contact. */
  egress?: string[];
  /** Paths the operation will write. */
  fsWrites?: string[];
  /** Secret env keys the operation needs exposed (secret-scoped env). */
  secrets?: string[];
}

/**
 * Check declared needs against the project's scope regime. Returns a human-readable denial
 * reason, or `null` when allowed. Never throws (an error along the trust path surfaces as a
 * denial via `profileBrokerPolicy`'s active+null policy, not an exception).
 */
export async function checkScopeNeeds(
  needs: ScopeNeeds,
  cwd = process.cwd(),
): Promise<string | null> {
  const declaresAnything =
    (needs.egress?.length ?? 0) > 0 ||
    (needs.fsWrites?.length ?? 0) > 0 ||
    (needs.secrets?.length ?? 0) > 0;
  if (!declaresAnything) return null;

  const { regime, policy, detail } = await profileBrokerPolicy(cwd);
  if (regime === "none") return null; // no RoE regime declared — advisory floor unchanged
  if (!policy) {
    // Declared but unsigned/tampered/malformed — the RoE exists but is untrustworthy (fail-closed).
    return `scope enforcement: ${detail}`;
  }

  const deniedHosts = (needs.egress ?? []).filter(
    (h) => !checkEgress(h, { allow: policy.egress.allow }).ok,
  );
  if (deniedHosts.length > 0) {
    return `scope enforcement: egress to ${deniedHosts.join(", ")} is outside the signed [scope].egress`;
  }
  const roots = policyFsRoots(policy);
  const deniedPaths = (needs.fsWrites ?? []).filter(
    (p) => !roots.some((root) => checkFsWrite(resolve(cwd, p), root).ok),
  );
  if (deniedPaths.length > 0) {
    return `scope enforcement: write to ${deniedPaths.join(", ")} is outside the signed [scope].fs`;
  }
  const deniedSecrets = (needs.secrets ?? []).filter((k) => !policy.env.declared.includes(k));
  if (deniedSecrets.length > 0) {
    return `scope enforcement: secret(s) ${deniedSecrets.join(", ")} outside the signed [scope].secrets`;
  }
  return null;
}
