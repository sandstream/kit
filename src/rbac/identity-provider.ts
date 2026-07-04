/**
 * kit RBAC identity providers — the ENROLLMENT-ONLY IdP layer for Pelare 2.
 *
 * An IdP (GitHub today; Azure/Entra and Google are documented future backends of
 * the SAME interface) is consulted ONLY at enrollment time to compile role
 * bindings. It is NEVER imported by the enforcement path (`resolve.ts`) — the
 * decision engine is fully offline. The one and only network in this whole pillar
 * lives here, behind an INJECTABLE membership source, so the compilation logic is
 * unit-testable with zero egress.
 *
 * Flow:
 *   1. `createGithubProvider({ source, org })` wraps a `GithubMembershipSource`
 *      (team membership) into an `IdentityProvider` that yields group slugs.
 *   2. `compileRoleBindings({ provider, roleMap, subjects })` maps each subject's
 *      groups -> kit roles (via `roleMap`) -> signed-policy `RoleBinding[]` you
 *      paste into the `[rbac]` table before `kit policy sign`.
 *   3. `createGithubApiSource({ token, org, fetchImpl?, baseUrl? })` is the REAL
 *      GitHub Teams wiring that satisfies `GithubMembershipSource` — the injection
 *      point tests replace with an in-memory fake. `KIT_RBAC_GITHUB_API` overrides
 *      the base URL (e.g. GitHub Enterprise).
 *
 * FUTURE BACKENDS (same `IdentityProvider` / membership-source shape):
 *   - Azure / Entra ID: Microsoft Graph `GET /me/memberOf` (group objectIds/names).
 *   - Google: Cloud Identity Groups `groups.memberships.searchTransitiveGroups`.
 * Each becomes a `create<X>Source(...)` returning the membership interface; the
 * compile + enforcement code is unchanged.
 *
 * Enrollment egress note: `createGithubApiSource` MUST be gated by kit's egress
 * policy and MUST NOT be reachable from the decision path (enforced by the
 * no-restricted-imports boundary + the architecture-guard test).
 */
import { identityId } from "../identity.js";
import type { RoleBinding } from "./policy-schema.js";

/**
 * A pluggable identity provider. `resolveMembership` returns the group slugs a
 * subject belongs to (already namespaced by org where relevant).
 */
export interface IdentityProvider {
  /** Provider kind, e.g. "github". */
  kind: string;
  /** Resolve the group slugs a subject belongs to. Enrollment-time only. */
  resolveMembership(subject: string): Promise<string[]>;
}

/**
 * The injectable GitHub membership source. Real wiring (`createGithubApiSource`)
 * talks to the GitHub Teams API; tests inject an in-memory implementation so no
 * network is touched.
 */
export interface GithubMembershipSource {
  /** Team slugs the subject (GitHub login) is an active member of. */
  listTeams(subject: string): Promise<string[]>;
}

/**
 * Wrap a `GithubMembershipSource` into an `IdentityProvider`. When `org` is set,
 * group slugs are namespaced as `org/team` (so `roleMap` keys are unambiguous
 * across orgs); otherwise the bare team slug is used.
 */
export function createGithubProvider(opts: {
  source: GithubMembershipSource;
  org?: string;
}): IdentityProvider {
  return {
    kind: "github",
    async resolveMembership(subject: string): Promise<string[]> {
      const teams = await opts.source.listTeams(subject);
      return teams.map((t) => (opts.org ? `${opts.org}/${t}` : t));
    },
  };
}

/** A subject to enroll: the IdP identity plus its kit identity id (and optional key). */
export interface EnrollmentSubject {
  /** The IdP subject (e.g. GitHub login) passed to the provider. */
  subject: string;
  /** The subject's kit identity id (kid_...) to bind. */
  kid: string;
  /** Optional SPKI PEM; when present it MUST derive to `kid` (checked, else throws). */
  pubkey?: string;
  /** Optional human label carried into the binding. */
  label?: string;
}

export interface EnrollmentInput {
  provider: IdentityProvider;
  /** group slug -> kit role name. Subjects in unmapped groups produce no binding. */
  roleMap: Record<string, string>;
  subjects: EnrollmentSubject[];
}

export interface EnrollmentResult {
  /** Compiled bindings to paste into the `[rbac]` table before signing. */
  bindings: RoleBinding[];
  /** Subjects that matched no mapped group (no binding emitted) — surfaced, not silently dropped. */
  unmapped: EnrollmentSubject[];
}

/**
 * Compile role bindings for a set of subjects by resolving each subject's IdP
 * groups and mapping them through `roleMap`. Deterministic given the injected
 * provider. A subject in multiple mapped groups yields multiple bindings (one per
 * distinct role) — permissions UNION at decision time. A subject in no mapped
 * group is reported in `unmapped`. If a subject supplies a `pubkey` that does not
 * derive to its `kid`, enrollment FAILS LOUD (throws) — a mismatch must never be
 * written into a signed policy.
 */
export async function compileRoleBindings(input: EnrollmentInput): Promise<EnrollmentResult> {
  const bindings: RoleBinding[] = [];
  const unmapped: EnrollmentSubject[] = [];

  for (const subject of input.subjects) {
    if (subject.pubkey !== undefined) {
      let derived: string;
      try {
        derived = identityId(subject.pubkey);
      } catch {
        throw new Error(`pubkey for subject "${subject.subject}" is not a valid public key`);
      }
      if (derived !== subject.kid) {
        throw new Error(
          `pubkey for subject "${subject.subject}" derives to ${derived}, not its kid ${subject.kid}`,
        );
      }
    }

    const groups = await input.provider.resolveMembership(subject.subject);
    const roles = [...new Set(groups.map((g) => input.roleMap[g]).filter((r): r is string => !!r))];

    if (roles.length === 0) {
      unmapped.push(subject);
      continue;
    }

    for (const role of roles) {
      const binding: RoleBinding = { kid: subject.kid, role };
      if (subject.pubkey !== undefined) binding.pubkey = subject.pubkey;
      if (subject.label !== undefined) binding.label = subject.label;
      bindings.push(binding);
    }
  }

  return { bindings, unmapped };
}

/**
 * The REAL GitHub Teams membership source. This is the only network in the pillar
 * and runs at enrollment only. Lists the org's teams, then checks the subject's
 * active membership in each, returning the team slugs they belong to. Fail-closed:
 * a non-OK response throws rather than reporting spurious (empty) membership.
 *
 * `baseUrl` order: `KIT_RBAC_GITHUB_API` env override, then `opts.baseUrl`, then
 * the public GitHub API. `fetchImpl` is injectable so tests drive it with a fake.
 */
export function createGithubApiSource(opts: {
  token: string;
  org: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): GithubMembershipSource {
  const baseUrl = (
    process.env.KIT_RBAC_GITHUB_API ??
    opts.baseUrl ??
    "https://api.github.com"
  ).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  return {
    async listTeams(subject: string): Promise<string[]> {
      const teamsRes = await doFetch(`${baseUrl}/orgs/${opts.org}/teams`, { headers });
      if (!teamsRes.ok) {
        throw new Error(`GitHub teams list failed for org ${opts.org}: HTTP ${teamsRes.status}`);
      }
      const teams = (await teamsRes.json()) as Array<{ slug: string }>;
      const member: string[] = [];
      for (const team of teams) {
        const mRes = await doFetch(
          `${baseUrl}/orgs/${opts.org}/teams/${team.slug}/memberships/${subject}`,
          { headers },
        );
        if (mRes.status === 404) continue; // not a member — expected, not an error
        if (!mRes.ok) {
          throw new Error(
            `GitHub membership check failed for ${subject} in ${team.slug}: HTTP ${mRes.status}`,
          );
        }
        const body = (await mRes.json()) as { state?: string };
        if (body.state === "active") member.push(team.slug);
      }
      return member;
    },
  };
}
