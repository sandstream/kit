/**
 * kit RBAC schema — Pillar 2 (role-based access control bound to an IdP at
 * ENROLLMENT time, enforced fully OFFLINE from the org-signed `.kit-policy.toml`).
 *
 * This module is the PURE, zero-dependency schema shared by the enforcement path
 * (`resolve.ts`) and the enrollment path (`identity-provider.ts`). Keeping it
 * separate does two things:
 *   1. avoids a circular dependency (resolve.ts ⇄ identity-provider.ts), and
 *   2. keeps the decision engine free of any provider / network code — the
 *      enforcement path never transitively imports the GitHub/Azure/Google wiring.
 *
 * Role-bindings live INSIDE the policy document (`[rbac]` table): subject kid ->
 * role -> permissions[]. Because bindings ride inside `.kit-policy.toml`, they are
 * already covered by the SINGLE org signature (`canonicalPolicyBytes` signs the
 * whole doc) and verified offline against `.kit-policy.signers`. There is no
 * separate RBAC signature and no network at decision time.
 *
 * No I/O, no model calls, deterministic. Fail-CLOSED: a malformed `[rbac]` table
 * yields `extractRbac(...) === null`, which the resolver treats as "no bindings"
 * (total deny) rather than guessing an interpretation.
 */

/** A single subject -> role assignment, compiled at enrollment and signed in-policy. */
export interface RoleBinding {
  /** The subject identity id (kid_...) this binding authorizes. */
  kid: string;
  /** The role name; must exist in `RbacPolicy.roles`. */
  role: string;
  /**
   * Optional SPKI PEM of the subject's public key. When present, the resolver
   * checks that `identityId(pubkey) === kid` and IGNORES the binding otherwise —
   * so a pubkey/kid mismatch can never grant access (fail-closed integrity).
   */
  pubkey?: string;
  /** Optional human label (e.g. GitHub login) for diagnostics. */
  label?: string;
}

/** The `[rbac]` table, normalized. `roles` maps a role name to its permission grants. */
export interface RbacPolicy {
  /** role -> permission grants. A grant is exact (`deploy:prod`), a `domain:*` prefix, or `*`. */
  roles: Record<string, string[]>;
  /** Subject -> role assignments. A kid may appear more than once (permissions UNION). */
  bindings: RoleBinding[];
  /** Optional role granted to a subject that has NO binding of its own. */
  defaultRole?: string;
}

export interface RbacValidation {
  ok: boolean;
  errors: string[];
}

const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkForbiddenKeys(obj: Record<string, unknown>, where: string, errors: string[]): void {
  for (const k of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k))
      errors.push(`forbidden key \`${k}\` in ${where}`);
  }
}

/**
 * Validate the `[rbac]` table carried on a parsed policy document. Pure.
 *
 * `doc` is the WHOLE parsed policy doc; this reads `doc.rbac`. A doc with no
 * `[rbac]` table is valid (RBAC is optional) and yields `{ ok: true, errors: [] }`.
 * A present-but-malformed `[rbac]` table produces structured errors.
 */
export function validateRbac(doc: unknown): RbacValidation {
  const errors: string[] = [];
  if (!isPlainObject(doc)) {
    return { ok: false, errors: ["policy is not a table"] };
  }
  const rbac = doc.rbac;
  if (rbac === undefined) return { ok: true, errors: [] };
  if (!isPlainObject(rbac)) {
    return { ok: false, errors: ["`rbac` must be a table"] };
  }
  checkForbiddenKeys(rbac, "`rbac`", errors);

  // roles: Record<string, string[]>
  if (rbac.roles === undefined) {
    errors.push("`rbac.roles` is required");
  } else if (!isPlainObject(rbac.roles)) {
    errors.push("`rbac.roles` must be a table");
  } else {
    checkForbiddenKeys(rbac.roles, "`rbac.roles`", errors);
    for (const [role, perms] of Object.entries(rbac.roles)) {
      if (!Array.isArray(perms) || perms.some((p) => typeof p !== "string")) {
        errors.push(`\`rbac.roles.${role}\` must be an array of permission strings`);
      }
    }
  }

  // bindings: RoleBinding[]
  if (rbac.bindings === undefined) {
    errors.push("`rbac.bindings` is required (may be an empty array)");
  } else if (!Array.isArray(rbac.bindings)) {
    errors.push("`rbac.bindings` must be an array of tables");
  } else {
    rbac.bindings.forEach((b, i) => {
      if (!isPlainObject(b)) {
        errors.push(`\`rbac.bindings[${i}]\` must be a table`);
        return;
      }
      checkForbiddenKeys(b, `\`rbac.bindings[${i}]\``, errors);
      if (typeof b.kid !== "string" || b.kid.length === 0) {
        errors.push(`\`rbac.bindings[${i}].kid\` must be a non-empty string`);
      }
      if (typeof b.role !== "string" || b.role.length === 0) {
        errors.push(`\`rbac.bindings[${i}].role\` must be a non-empty string`);
      }
      if (b.pubkey !== undefined && typeof b.pubkey !== "string") {
        errors.push(`\`rbac.bindings[${i}].pubkey\` must be a string`);
      }
      if (b.label !== undefined && typeof b.label !== "string") {
        errors.push(`\`rbac.bindings[${i}].label\` must be a string`);
      }
    });
  }

  // default_role: optional string
  if (rbac.default_role !== undefined && typeof rbac.default_role !== "string") {
    errors.push("`rbac.default_role` must be a string");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Pull and normalize the `[rbac]` table out of a parsed policy document.
 *
 * Returns a normalized `RbacPolicy` or `null` when there is no `[rbac]` table OR
 * when it is malformed (fail-CLOSED: a broken table must never be interpreted as
 * a permissive grant — the resolver treats `null` as "no bindings", total deny).
 */
export function extractRbac(doc: unknown): RbacPolicy | null {
  if (!validateRbac(doc).ok) return null;
  if (!isPlainObject(doc)) return null;
  const rbac = doc.rbac;
  if (!isPlainObject(rbac)) return null;

  const roles: Record<string, string[]> = {};
  const rawRoles = rbac.roles;
  if (isPlainObject(rawRoles)) {
    for (const [role, perms] of Object.entries(rawRoles)) {
      if (FORBIDDEN_KEYS.includes(role)) continue;
      roles[role] = (perms as string[]).map((p) => String(p));
    }
  }

  const bindings: RoleBinding[] = [];
  const rawBindings = rbac.bindings;
  if (Array.isArray(rawBindings)) {
    for (const b of rawBindings) {
      if (!isPlainObject(b)) continue;
      const binding: RoleBinding = { kid: String(b.kid), role: String(b.role) };
      if (typeof b.pubkey === "string") binding.pubkey = b.pubkey;
      if (typeof b.label === "string") binding.label = b.label;
      bindings.push(binding);
    }
  }

  const out: RbacPolicy = { roles, bindings };
  if (typeof rbac.default_role === "string") out.defaultRole = rbac.default_role;
  return out;
}

/**
 * Does a permission grant match a requested permission? Pure, deterministic.
 *   - `*`            matches anything
 *   - `domain:*`     matches any `domain:...` (prefix match, e.g. `secrets:*`)
 *   - exact          matches only itself
 */
export function permissionMatches(grant: string, requested: string): boolean {
  if (grant === "*") return true;
  if (grant === requested) return true;
  if (grant.endsWith(":*")) {
    const prefix = grant.slice(0, -1); // keep the trailing colon, drop the star
    return requested.startsWith(prefix);
  }
  return false;
}
