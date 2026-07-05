/**
 * kit RBAC resolver — the OFFLINE, deterministic, fail-CLOSED decision engine
 * for Pelare 2.
 *
 * `can(subjectKid, permission, verifiedPolicy)` and
 * `effectivePermissions(subjectKid, verifiedPolicy)` are PURE functions over a
 * `VerifiedPolicy`. There is ZERO network at decision time: authority comes
 * entirely from the org-signed `.kit-policy.toml`, whose signature is verified
 * offline against the committed `.kit-policy.signers` trust anchor (or the local
 * identity / a pinned key) by the existing `verifyPolicy`.
 *
 * FAIL-CLOSED, no false green. A decision can only ever be ALLOW when:
 *   - `verify.status === "valid"` (unsigned / unverifiable / invalid / revoked
 *     policy => deny). `loadVerifiedPolicy` returns `null` unless the verdict is
 *     valid, AND `can`/`effectivePermissions` DEFENSIVELY re-check the verdict, so
 *     a hand-built object carrying a non-valid verdict can never yield an allow.
 *   - the subject has a matching binding (or the policy sets a `defaultRole`), and
 *   - the subject kid is NOT locally revoked (`isRevoked` — a SECONDARY deny; see
 *     the honesty note below).
 *   - if the binding carries a pubkey, `identityId(pubkey) === kid` (a mismatched
 *     binding is ignored — it cannot grant).
 *
 * HONESTY — subject revocation authority: the authoritative offline revocation of
 * a subject is the ORG re-signing the policy with the binding removed. `isRevoked`
 * reads the machine-LOCAL `revocations.jsonl`, NOT an org-distributed CRL, so it
 * is only a secondary, best-effort deny signal — never implied live org revocation.
 *
 * Imports ONLY policy-doc.ts, identity.ts, and the pure policy-schema.ts. It never
 * imports identity-provider.ts or any network primitive (asserted by a test) so
 * the enforcement surface stays offline.
 */
import { loadPolicy, verifyPolicy } from "../policy-doc.js";
import type { PolicyDoc, PolicyVerifyResult } from "../policy-doc.js";
import {
  identityId,
  isRevokedWith,
  localPublicKeys,
  localRevocationAuthorities,
} from "../identity.js";
import { policySignersMap } from "../policy-trust.js";
import { extractRbac, permissionMatches } from "./policy-schema.js";
import type { RbacPolicy } from "./policy-schema.js";

/** A policy that has been loaded AND cryptographically verified offline. */
export interface VerifiedPolicy {
  /** Repo root the policy was loaded from. */
  root: string;
  /** The parsed policy document. */
  doc: PolicyDoc;
  /** The normalized `[rbac]` table, or null when absent/malformed (=> total deny). */
  rbac: RbacPolicy | null;
  /** The verification verdict. Only `status === "valid"` may ever yield an allow. */
  verify: PolicyVerifyResult;
}

/**
 * Resolve the policy root: `KIT_RBAC_POLICY` env override wins, then an explicit
 * `override`, then the current working directory (the kiro `??` convention).
 */
export function rbacPolicyRoot(override?: string): string {
  return process.env.KIT_RBAC_POLICY ?? override ?? process.cwd();
}

/**
 * Load + verify the policy at `root`. Returns a `VerifiedPolicy` ONLY when the
 * signature verdict is `valid`; returns `null` for every other verdict (unsigned,
 * unverifiable, invalid, revoked) — total deny on an untrustworthy policy.
 */
export function loadVerifiedPolicy(
  root: string,
  opts: { key?: string } = {},
): VerifiedPolicy | null {
  const verify = verifyPolicy(root, opts);
  if (verify.status !== "valid") return null;
  const doc = loadPolicy(root);
  if (!doc) return null; // defensive: verify said valid, so a doc must exist
  return { root, doc, rbac: extractRbac(doc), verify };
}

/** Is a verified-policy object actually usable for an ALLOW? Fail-closed guard. */
function usable(vp: VerifiedPolicy | null): vp is VerifiedPolicy {
  // Re-check the verdict here (not just at load) so an object hand-built with a
  // non-valid verdict — or one whose verdict was mutated after load — can never
  // produce a green decision.
  return !!vp && vp.verify.status === "valid" && vp.rbac !== null;
}

/** Bindings that authorize `subjectKid`, dropping any whose pubkey/kid mismatch. */
function bindingsFor(subjectKid: string, rbac: RbacPolicy): RbacPolicy["bindings"] {
  return rbac.bindings.filter((b) => {
    if (b.kid !== subjectKid) return false;
    if (b.pubkey !== undefined) {
      try {
        if (identityId(b.pubkey) !== b.kid) return false; // integrity: pubkey must derive to kid
      } catch {
        return false; // malformed pubkey => ignore the binding (fail-closed)
      }
    }
    return true;
  });
}

/**
 * The set of permission grants a subject effectively holds under a verified
 * policy. Pure and fail-closed: returns `[]` for a null/non-valid policy, an
 * absent `[rbac]` table, or an unknown subject with no `defaultRole`. Grants from
 * multiple bindings/roles are UNIONed (a kid may hold several roles by design).
 */
export function effectivePermissions(
  subjectKid: string,
  verifiedPolicy: VerifiedPolicy | null,
): string[] {
  if (!usable(verifiedPolicy)) return [];
  const rbac = verifiedPolicy.rbac!;
  const matched = bindingsFor(subjectKid, rbac);

  let roleNames: string[];
  if (matched.length > 0) {
    roleNames = matched.map((b) => b.role);
  } else if (rbac.defaultRole !== undefined) {
    roleNames = [rbac.defaultRole];
  } else {
    return []; // unknown subject, no default => deny
  }

  const perms = new Set<string>();
  for (const role of roleNames) {
    // `Object.hasOwn` guard: a binding whose role is an inherited Object.prototype
    // name (e.g. "toString") must resolve to NO grants, not the inherited method
    // (which would be truthy and non-iterable → a throw). Own-property only.
    const grants = Object.hasOwn(rbac.roles, role) ? rbac.roles[role] : undefined;
    if (!grants) continue;
    for (const g of grants) perms.add(g);
  }
  return [...perms];
}

/**
 * Can `subjectKid` perform `permission` under `verifiedPolicy`? Pure, deterministic,
 * fail-CLOSED. Denies on: null/non-valid policy, absent `[rbac]`, unknown subject
 * (no matching binding and no defaultRole), a role missing from the roles table, a
 * pubkey/kid-mismatched binding, or a LOCALLY revoked subject kid (secondary deny).
 */
export function can(
  subjectKid: string,
  permission: string,
  verifiedPolicy: VerifiedPolicy | null,
): boolean {
  if (!usable(verifiedPolicy)) return false;
  // Secondary deny: an AUTHORITATIVE revocation of the subject — self-revoked, or revoked
  // by this machine's local root or an org trust-anchor signer, with a verifying signature.
  // (Unauthorized/unsigned records are ignored so a planted line can't deny a real subject.)
  const orgSigners = policySignersMap(verifiedPolicy!.root);
  const trustedKeys = new Map<string, string>([...localPublicKeys(), ...orgSigners]);
  const authorities = new Set<string>([...localRevocationAuthorities(), ...orgSigners.keys()]);
  if (isRevokedWith(subjectKid, trustedKeys, authorities)) return false;
  const perms = effectivePermissions(subjectKid, verifiedPolicy);
  return perms.some((grant) => permissionMatches(grant, permission));
}
