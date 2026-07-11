/**
 * kit RBAC — cloud identity-provider backends for Pillar 2 (Microsoft Entra ID
 * and Google Cloud Identity), siblings of the GitHub backend in
 * identity-provider.ts. Like GitHub, these are consulted ONLY at ENROLLMENT time
 * to compile role bindings; they are NEVER imported by the enforcement path
 * (resolve.ts), so the decision engine stays fully offline (asserted by the
 * architecture-guard test). The only network lives here, behind an INJECTABLE
 * membership source, so the compile/parse logic is unit-testable with zero egress.
 *
 * Both satisfy the same `IdentityProvider` shape as GitHub via a thin
 * `create<X>Provider(...)` wrapper, so `compileRoleBindings` is unchanged.
 *
 * CONFIDENCE: the live endpoint SHAPES below are the documented ones (Graph
 * `memberOf`; Cloud Identity `memberships:searchTransitiveGroups`) but, like the
 * GitHub API source, they should be verified against a real tenant before relying
 * on them in production. Fail-CLOSED: any non-OK response THROWS rather than
 * reporting spurious (empty) membership. Enrollment egress MUST be gated by kit's
 * egress policy (exec-broker) — same note as the GitHub source.
 */
import type { IdentityProvider } from "./identity-provider.js";

/* ------------------------------------------------------------------ Entra ID */

/** Injectable Microsoft Entra ID (Azure AD) membership source. */
export interface EntraMembershipSource {
  /** Group names/ids the subject (user principal name or object id) belongs to. */
  listGroups(subject: string): Promise<string[]>;
}

/**
 * Wrap an `EntraMembershipSource` into an `IdentityProvider`. When `tenant` is
 * set, group slugs are namespaced as `tenant/group` (so `roleMap` keys are
 * unambiguous across tenants); otherwise the bare group slug is used.
 */
export function createEntraProvider(opts: {
  source: EntraMembershipSource;
  tenant?: string;
}): IdentityProvider {
  return {
    kind: "entra",
    async resolveMembership(subject: string): Promise<string[]> {
      const groups = await opts.source.listGroups(subject);
      return groups.map((g) => (opts.tenant ? `${opts.tenant}/${g}` : g));
    },
  };
}

interface GraphDirObject {
  "@odata.type"?: string;
  id?: string;
  displayName?: string;
}
interface GraphMemberOfPage {
  value?: GraphDirObject[];
  "@odata.nextLink"?: string;
}

/**
 * The REAL Microsoft Graph membership source. Lists the subject's group
 * memberships via `GET /v1.0/users/{subject}/memberOf`, following `@odata.nextLink`
 * pagination, and returns each group's `displayName` (falling back to `id`).
 * Directory objects that are not groups (roles, etc.) are ignored. Fail-closed:
 * a non-OK response throws.
 *
 * `baseUrl` order: `KIT_RBAC_ENTRA_API` env override, then `opts.baseUrl`, then
 * the public Graph endpoint. `fetchImpl` is injectable so tests drive it with a fake.
 */
export function createEntraApiSource(opts: {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): EntraMembershipSource {
  const baseUrl = (
    process.env.KIT_RBAC_ENTRA_API ??
    opts.baseUrl ??
    "https://graph.microsoft.com"
  ).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${opts.token}`, Accept: "application/json" };

  return {
    async listGroups(subject: string): Promise<string[]> {
      const groups: string[] = [];
      // `transitiveMemberOf` (NOT `memberOf`, which is direct-only) so nested-group
      // membership is included — symmetric with Google's transitive search. The
      // `/microsoft.graph.group` OData cast narrows the result to groups server-side.
      let url: string | undefined =
        `${baseUrl}/v1.0/users/${encodeURIComponent(subject)}/transitiveMemberOf/microsoft.graph.group?$select=id,displayName`;
      // Follow pagination; a bounded guard avoids an accidental infinite loop.
      for (let page = 0; url && page < 100; page++) {
        const res = await doFetch(url, { headers });
        if (!res.ok) {
          throw new Error(`Entra transitiveMemberOf failed for ${subject}: HTTP ${res.status}`);
        }
        const body = (await res.json()) as GraphMemberOfPage;
        for (const obj of body.value ?? []) {
          // The cast already restricts to groups; keep a DEFENSIVE drop of any
          // object that is explicitly a non-group type, but accept objects that
          // omit @odata.type (the cast endpoint often does).
          const t = obj["@odata.type"];
          if (t !== undefined && t !== "#microsoft.graph.group") continue;
          const slug = obj.displayName ?? obj.id;
          if (typeof slug === "string" && slug.length > 0) groups.push(slug);
        }
        url = body["@odata.nextLink"];
      }
      return groups;
    },
  };
}

/* --------------------------------------------------------------- Google Cloud */

/** Injectable Google Cloud Identity membership source. */
export interface GoogleMembershipSource {
  /** Group keys (emails/ids) the subject (member email) transitively belongs to. */
  listGroups(subject: string): Promise<string[]>;
}

/**
 * Wrap a `GoogleMembershipSource` into an `IdentityProvider`. When `domain` is
 * set, group slugs are namespaced as `domain/group`; otherwise the bare group key
 * is used.
 */
export function createGoogleProvider(opts: {
  source: GoogleMembershipSource;
  domain?: string;
}): IdentityProvider {
  return {
    kind: "google",
    async resolveMembership(subject: string): Promise<string[]> {
      const groups = await opts.source.listGroups(subject);
      return groups.map((g) => (opts.domain ? `${opts.domain}/${g}` : g));
    },
  };
}

interface CloudIdentityMembership {
  groupKey?: { id?: string };
  displayName?: string;
}
interface CloudIdentityPage {
  memberships?: CloudIdentityMembership[];
  nextPageToken?: string;
}

/**
 * The REAL Google Cloud Identity membership source. Resolves the subject's
 * transitive group memberships via
 * `GET /v1/groups/-/memberships:searchTransitiveGroups?query=member_key_id=='{subject}'`,
 * following `nextPageToken` pagination, and returns each group's `groupKey.id`
 * (the group email). Fail-closed: a non-OK response throws.
 *
 * `baseUrl` order: `KIT_RBAC_GOOGLE_API` env override, then `opts.baseUrl`, then
 * the public Cloud Identity endpoint. `fetchImpl` is injectable for tests.
 */
export function createGoogleApiSource(opts: {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): GoogleMembershipSource {
  const baseUrl = (
    process.env.KIT_RBAC_GOOGLE_API ??
    opts.baseUrl ??
    "https://cloudidentity.googleapis.com"
  ).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${opts.token}`, Accept: "application/json" };

  return {
    async listGroups(subject: string): Promise<string[]> {
      // CEL-injection guard: the subject is interpolated inside a single-quoted
      // CEL string literal and encodeURIComponent does NOT escape `'`, so a
      // subject containing a quote could break out of the literal. Valid member
      // keys (emails) never contain one — reject fail-closed rather than escape.
      if (subject.includes("'")) {
        throw new Error(
          `Google Cloud Identity: invalid subject ${JSON.stringify(subject)} (contains quote)`,
        );
      }
      const groups: string[] = [];
      // The searchTransitiveGroups query MUST include BOTH a member spec AND a
      // label term — omitting labels is an HTTP 400. Restrict to standard Google
      // Groups (the discussion_forum label).
      const query = encodeURIComponent(
        `member_key_id == '${subject}' && 'cloudidentity.googleapis.com/groups.discussion_forum' in labels`,
      );
      let pageToken: string | undefined;
      for (let page = 0; page < 100; page++) {
        const url =
          `${baseUrl}/v1/groups/-/memberships:searchTransitiveGroups?query=${query}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await doFetch(url, { headers });
        if (!res.ok) {
          throw new Error(`Google Cloud Identity search failed for ${subject}: HTTP ${res.status}`);
        }
        const body = (await res.json()) as CloudIdentityPage;
        for (const m of body.memberships ?? []) {
          const slug = m.groupKey?.id;
          if (typeof slug === "string" && slug.length > 0) groups.push(slug);
        }
        if (!body.nextPageToken) break;
        pageToken = body.nextPageToken;
      }
      return groups;
    },
  };
}
