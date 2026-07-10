/**
 * kit exec-broker — declared operation needs vs the signed scope (Pillar 3 step 5).
 *
 * Design: `pillar3-exec-broker-5.0.md` §3.4 / §6.4. An operation running under
 * `withGovernance` DECLARES what it is about to touch — hosts, write paths, secret env keys —
 * and this module answers whether the signed `[scope]`/RoE grants it. This is what makes the
 * governance floor an exec-broker: secret-scoped env lives here (an op that doesn't declare a
 * key doesn't get it granted), alongside egress and fs.
 *
 * Opt-in semantics, mirrored from the PreToolUse gates but adapted to a floor that runs for
 * EVERY governed op:
 *   - no scope regime declared at all ("none") → nothing to enforce; advisory floor unchanged
 *     (backward compatible — projects without a profile see no behavior change);
 *   - a scope IS declared but unsigned/tampered ("unsigned"/"invalid") → the regime exists but
 *     is not trustworthy: declared needs are DENIED (fail-closed — declaring a scope is the
 *     opt-in, and only a verified one grants);
 *   - verified → each declared need must be inside the scope (pure predicates from scope.ts).
 *
 * Deterministic, zero-LLM, local-only.
 */
import { brokerStatus } from "./decide.js";
import { hostInScope, pathInScope, secretInScope } from "./scope.js";

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
 * denial via brokerStatus's `invalid` state, not an exception).
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

  const st = await brokerStatus(cwd);
  if (st.state === "none") return null; // no RoE regime declared — advisory floor unchanged
  if (st.state !== "verified" || !st.scope) {
    return `scope enforcement: ${st.detail}`;
  }

  const scope = st.scope;
  const deniedHosts = (needs.egress ?? []).filter((h) => !hostInScope(h, scope));
  if (deniedHosts.length > 0) {
    return `scope enforcement: egress to ${deniedHosts.join(", ")} is outside the signed [scope].egress`;
  }
  const deniedPaths = (needs.fsWrites ?? []).filter((p) => !pathInScope(p, scope, cwd));
  if (deniedPaths.length > 0) {
    return `scope enforcement: write to ${deniedPaths.join(", ")} is outside the signed [scope].fs`;
  }
  const deniedSecrets = (needs.secrets ?? []).filter((k) => !secretInScope(k, scope));
  if (deniedSecrets.length > 0) {
    return `scope enforcement: secret(s) ${deniedSecrets.join(", ")} outside the signed [scope].secrets`;
  }
  return null;
}
