/**
 * kit exec-broker — the fail-closed scope source + honest status (Pillar 3 steps 2–3).
 *
 * Design: `kit-research/docs/research/pillar3-exec-broker-5.0.md` §3.2.
 *
 * The broker's SCOPE comes from exactly one place: the profile's signed `[scope]`/RoE via
 * `verifiedScope()` (Pillar 4). This module wraps that source for the ENFORCEMENT paths:
 *
 *   - `brokerScope(cwd)` — never-throws: any error (malformed profile, unreadable sig, …)
 *     resolves to `null`, and a `null` scope GRANTS NOTHING. An enforcement point must never
 *     crash open — an exception in the trust path is a deny, not a bypass.
 *   - `brokerStatus(cwd)` — the honest posture for `kit doctor`: verified / unsigned /
 *     invalid / none. "Enforced" must never silently mean "no-op", and a degradation
 *     (declared-but-unsigned scope) is surfaced, never swallowed.
 *
 * Deterministic, zero-LLM, local-only (file reads + offline signature verify).
 */
import { loadProfile, type ProfileScope } from "../profile/schema.js";
import { verifyProfileSignature } from "../profile/sign.js";

export type BrokerScopeState =
  /** A `[scope]` is declared and its signature verifies — this scope governs. */
  | "verified"
  /** A `[scope]` is declared but unsigned / signer unknown — grants nothing (fail-closed). */
  | "unsigned"
  /** Signature invalid/revoked, or the profile itself is malformed — grants nothing. */
  | "invalid"
  /** No profile or no `[scope]` section — there is no RoE for the broker to enforce. */
  | "none";

export interface BrokerStatus {
  state: BrokerScopeState;
  /** The governing scope — non-null ONLY when state is "verified". */
  scope: ProfileScope | null;
  detail: string;
}

/**
 * The broker's honest posture. Never throws — a malformed profile is reported as `invalid`
 * (a broken artifact must not crash the status surface, and must never read as healthy).
 */
export async function brokerStatus(cwd = process.cwd()): Promise<BrokerStatus> {
  let scope: ProfileScope | undefined;
  try {
    const profile = await loadProfile(cwd);
    if (!profile) return { state: "none", scope: null, detail: "no profile declared" };
    scope = profile.scope;
  } catch (err) {
    return {
      state: "invalid",
      scope: null,
      detail: `profile unreadable — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!scope) {
    return { state: "none", scope: null, detail: "profile declares no [scope]/RoE" };
  }

  const v = await verifyProfileSignature(cwd);
  switch (v.status) {
    case "valid": {
      const parts = [
        `${scope.egress?.length ?? 0} egress host(s)`,
        `${scope.fs?.length ?? 0} fs path(s)`,
        `${scope.secrets?.length ?? 0} secret key(s)`,
      ];
      return {
        state: "verified",
        scope,
        detail: `scope verified — ${parts.join(", ")} (${v.detail})`,
      };
    }
    case "unsigned":
    case "unverifiable":
      return {
        state: "unsigned",
        scope: null,
        detail: `scope declared but ${v.detail} — grants nothing (fail-closed)`,
      };
    case "invalid":
    case "revoked":
      return {
        state: "invalid",
        scope: null,
        detail: `scope signature ${v.status} — ${v.detail}; grants nothing (fail-closed)`,
      };
  }
}

/**
 * The scope the enforcement points act on: the verified `[scope]`, or `null` when anything
 * along the trust path is missing, broken, or forged. Never throws — an exception in the
 * trust path is a deny (`null`), not a bypass.
 */
export async function brokerScope(cwd = process.cwd()): Promise<ProfileScope | null> {
  try {
    const st = await brokerStatus(cwd);
    return st.state === "verified" ? st.scope : null;
  } catch {
    return null;
  }
}
