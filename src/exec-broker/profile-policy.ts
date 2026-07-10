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
  /**
   * Did the scope opt IN to ENFORCING runtime mediation (`[scope].enforce_runtime = true`)? Read
   * from the DECLARATION regardless of signature status: opted-in + unsigned ⇒ this is true AND
   * `policy` is null, so the runtime default-denies declared ops (fail-closed). False for observe /
   * off / no scope / unreadable. Equivalent to `runtimeMode === "enforce"` (kept for back-compat).
   */
  enforceRuntime: boolean;
  /**
   * The declared runtime posture (Pillar 3 default-on ladder): `"off"` (absent/false — runtime
   * unchanged), `"observe"` (dry-run: mediate but never deny, audit would-be denials), or
   * `"enforce"` (mediate + deny). Read from the DECLARATION regardless of signature status.
   */
  runtimeMode: "off" | "observe" | "enforce";
  /**
   * Keyless "sign, don't store" hosts (Pillar 2 tail) declared in `[scope].sign`, read from the
   * DECLARATION regardless of signature status — so `kit doctor` can surface "declared but
   * unverified" as a fail-closed posture. Empty when no scope / none declared / unreadable.
   */
  signHostsDeclared: string[];
  /**
   * EFFECTIVE keyless hosts: the declared list, but ONLY when the scope's signature verified. Empty
   * otherwise (fail-closed) — an unverified `[scope].sign` grants no keyless behavior, mirroring how
   * an unverified scope yields a null broker policy.
   */
  signHosts: string[];
  detail: string;
}

interface ScopeShape {
  egress?: string[];
  fs?: string[];
  secrets?: string[];
  sign?: string[];
  enforce_runtime?: boolean | "observe";
}

/**
 * Map the signed `enforce_runtime` declaration onto the runtime posture (Pillar 3 default-on).
 *   - `"observe"` → dry-run (mediate, audit would-be denials, never deny);
 *   - `true`      → enforce (mediate + deny);
 *   - `false`     → explicit OFF (opt out of runtime mediation entirely);
 *   - ABSENT      → DEFAULT-ON: a declared scope mediates in `observe` by default. Turning mediation
 *     on by default is safe because observe never denies — nothing an upgrade could break; it only
 *     starts recording what enforce WOULD block. Enforce-by-default stays an explicit `true` until
 *     field evidence from observe justifies flipping it.
 */
function runtimeModeOf(scope: ScopeShape): "off" | "observe" | "enforce" {
  if (scope.enforce_runtime === "observe") return "observe";
  if (scope.enforce_runtime === true) return "enforce";
  if (scope.enforce_runtime === false) return "off";
  return "observe";
}

/** Map a verified profile `[scope]` onto a BrokerPolicy (fs paths resolved against `cwd`). */
function scopeToPolicy(scope: ScopeShape, cwd: string): BrokerPolicy {
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
  let scope: ScopeShape | undefined;
  try {
    const profile = await loadProfile(cwd);
    if (!profile) {
      return {
        regime: "none",
        policy: null,
        enforceRuntime: false,
        runtimeMode: "off",
        signHostsDeclared: [],
        signHosts: [],
        detail: "no profile declared",
      };
    }
    scope = profile.scope;
  } catch (err) {
    // A profile exists but is malformed — a declared-but-broken RoE. Treat as active+deny, never
    // "none" (a broken artifact must not silently disable enforcement). enforceRuntime is false: the
    // opt-in flag is unreadable, and the broken profile is surfaced as a hard fail by `kit doctor`.
    return {
      regime: "active",
      policy: null,
      enforceRuntime: false,
      runtimeMode: "off",
      signHostsDeclared: [],
      signHosts: [],
      detail: `profile unreadable — ${err instanceof Error ? err.message : String(err)} (default-deny)`,
    };
  }
  if (!scope) {
    return {
      regime: "none",
      policy: null,
      enforceRuntime: false,
      runtimeMode: "off",
      signHostsDeclared: [],
      signHosts: [],
      detail: "profile declares no [scope]/RoE",
    };
  }

  const runtimeMode = runtimeModeOf(scope);
  const enforceRuntime = runtimeMode === "enforce";
  const signHostsDeclared = scope.sign ? [...scope.sign] : [];
  const v = await verifyProfileSignature(cwd);
  if (v.status === "valid") {
    return {
      regime: "active",
      policy: scopeToPolicy(scope, cwd),
      enforceRuntime,
      runtimeMode,
      signHostsDeclared,
      signHosts: signHostsDeclared,
      detail: `scope verified (${v.detail})`,
    };
  }
  return {
    regime: "active",
    policy: null,
    enforceRuntime,
    runtimeMode,
    signHostsDeclared,
    signHosts: [],
    detail: `scope declared but ${v.status} — ${v.detail}; grants nothing (fail-closed)`,
  };
}
