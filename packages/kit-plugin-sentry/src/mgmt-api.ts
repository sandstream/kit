/**
 * Sentry REST API client.
 *
 * Why this exists alongside the official Sentry MCP server: kit needs
 * headless + scriptable Sentry ops in CI/cron contexts where browser-OAuth
 * is not available. Tokens come from the operator's vault (1P / Infisical /
 * etc.) via SENTRY_AUTH_TOKEN; the plugin never persists them.
 *
 * Read-only mode honored: every write surface (updateIssue, createRelease)
 * checks KIT_READ_ONLY=1 before touching the API.
 *
 * Auth: User Auth Token or Internal Integration Token with
 *   - org:read
 *   - project:read
 *   - event:read
 *   - event:write     (only if updating issues)
 *   - release:write   (only if creating releases)
 * See templates/iam/sentry.json for the recommended minimal scope.
 */

const DEFAULT_HOST = "https://sentry.io";

function assertNotReadOnly(operation: string): void {
  const v = process.env.KIT_READ_ONLY;
  if (v === "1" || v === "true") {
    throw new Error(`read-only mode active — refusing "${operation}"`);
  }
}

export interface MgmtClientConfig {
  /**
   * Sentry token. Defaults to SENTRY_AUTH_TOKEN.
   * Avoid passing raw tokens here — keep them in a vault and let the env-var
   * resolve at call time.
   */
  token?: string;
  /**
   * Region host. For EU customers this is `https://de.sentry.io`; for US it's
   * `https://sentry.io` (default) or `https://us.sentry.io`. Self-hosted
   * instances point at their own URL. Resolved automatically by `findOrganizations`
   * if you don't know it.
   */
  host?: string;
  /**
   * Organization slug. Required for most endpoints.
   */
  organizationSlug?: string;
}

export interface MgmtClient {
  host: string;
  organizationSlug?: string;
  headers: HeadersInit;
}

export function makeClient(cfg: MgmtClientConfig = {}): MgmtClient {
  const token = cfg.token ?? process.env.SENTRY_AUTH_TOKEN;
  if (!token) {
    throw new Error(
      "SENTRY_AUTH_TOKEN not set — create a token at https://sentry.io/settings/account/api/auth-tokens/ (or your regional URL) with org:read + project:read scopes (see templates/iam/sentry.json)",
    );
  }
  return {
    host: cfg.host ?? process.env.SENTRY_URL ?? DEFAULT_HOST,
    organizationSlug: cfg.organizationSlug,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "sandstream-kit-plugin-sentry",
    },
  };
}

export interface SentryOrganization {
  id: string;
  slug: string;
  name: string;
  region?: string;
}

export async function listOrganizations(client: MgmtClient): Promise<SentryOrganization[]> {
  const res = await fetch(`${client.host}/api/0/organizations/`, {
    headers: client.headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`GET /api/0/organizations/ returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as SentryOrganization[];
}

export interface SentryProject {
  id: string;
  slug: string;
  name: string;
  platform?: string;
  status?: string;
}

export async function listProjects(
  client: MgmtClient,
  organizationSlug?: string,
): Promise<SentryProject[]> {
  const org = organizationSlug ?? client.organizationSlug;
  if (!org) throw new Error("organizationSlug required");
  const res = await fetch(
    `${client.host}/api/0/organizations/${encodeURIComponent(org)}/projects/`,
    { headers: client.headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) {
    throw new Error(`GET /api/0/organizations/${org}/projects/ returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as SentryProject[];
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit?: string;
  permalink: string;
  status: "unresolved" | "resolved" | "ignored";
  substatus?: string;
  count?: string;
  userCount?: number;
  firstSeen: string;
  lastSeen: string;
  level?: string;
}

export interface SearchIssuesOptions {
  /** Sentry search syntax, e.g. "is:unresolved firstSeen:-24h" */
  query?: string;
  /** Project slug to scope the search. If absent, searches the org. */
  project?: string;
  /** Sort: date (last seen), freq, new (first seen), user */
  sort?: "date" | "freq" | "new" | "user";
  /** Max issues to return. Sentry default 25, max 100. */
  limit?: number;
}

export async function searchIssues(
  client: MgmtClient,
  opts: SearchIssuesOptions = {},
  organizationSlug?: string,
): Promise<SentryIssue[]> {
  const org = organizationSlug ?? client.organizationSlug;
  if (!org) throw new Error("organizationSlug required");
  const params = new URLSearchParams();
  if (opts.query) params.set("query", opts.query);
  if (opts.project) params.set("project", opts.project);
  if (opts.sort) params.set("sort", opts.sort);
  params.set("limit", String(Math.min(opts.limit ?? 25, 100)));
  const url = `${client.host}/api/0/organizations/${encodeURIComponent(org)}/issues/?${params}`;
  const res = await fetch(url, {
    headers: client.headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`GET .../issues/ returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as SentryIssue[];
}

export type UpdateIssueStatus =
  | "resolved"
  | "resolvedInNextRelease"
  | "unresolved"
  | "ignored";

export interface UpdateIssueOptions {
  status?: UpdateIssueStatus;
  /** Markdown note appended to the issue's activity feed. */
  reason?: string;
  /** Assign to a user (`user:ID`) or team (`team:SLUG`). */
  assignedTo?: string;
}

/**
 * Update an issue's status / assignment. Refuses in read-only mode.
 * Used by `kit sentry resolve <issue-id> --reason "..."` and
 * similar wrappers.
 */
export async function updateIssue(
  client: MgmtClient,
  issueId: string,
  opts: UpdateIssueOptions,
): Promise<SentryIssue> {
  assertNotReadOnly("sentry/updateIssue");
  const body: Record<string, unknown> = {};
  if (opts.status) body.status = opts.status;
  if (opts.assignedTo) body.assignedTo = opts.assignedTo;
  const res = await fetch(
    `${client.host}/api/0/issues/${encodeURIComponent(issueId)}/`,
    {
      method: "PUT",
      headers: client.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    throw new Error(`PUT /api/0/issues/${issueId}/ returned ${res.status}: ${await safeText(res)}`);
  }
  const updated = (await res.json()) as SentryIssue;

  // Sentry doesn't accept the reason in the PUT body — post as a comment.
  if (opts.reason) {
    await postIssueComment(client, issueId, opts.reason);
  }
  return updated;
}

async function postIssueComment(
  client: MgmtClient,
  issueId: string,
  comment: string,
): Promise<void> {
  const res = await fetch(
    `${client.host}/api/0/issues/${encodeURIComponent(issueId)}/comments/`,
    {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ text: comment }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok && res.status !== 404) {
    // 404 happens for issues without the comments-yet endpoint on some
    // self-hosted versions — treat as soft fail (status was already updated).
    console.error(
      `Sentry comment POST returned ${res.status}; issue status updated regardless.`,
    );
  }
}

export interface SentryEvent {
  id: string;
  eventID: string;
  message?: string;
  dateCreated: string;
  type?: string;
  platform?: string;
  tags?: Array<{ key: string; value: string }>;
}

export async function getIssueEvents(
  client: MgmtClient,
  issueId: string,
  limit = 10,
): Promise<SentryEvent[]> {
  const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
  const res = await fetch(
    `${client.host}/api/0/issues/${encodeURIComponent(issueId)}/events/?${params}`,
    { headers: client.headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) {
    throw new Error(`GET /api/0/issues/${issueId}/events/ returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as SentryEvent[];
}

export interface CreateReleaseOptions {
  version: string;
  projects: string[];
  refs?: Array<{ repository: string; commit: string; previousCommit?: string }>;
  url?: string;
}

export interface SentryRelease {
  version: string;
  ref?: string;
  url?: string;
  dateCreated: string;
  dateReleased?: string;
  projects: Array<{ slug: string; name: string }>;
}

/**
 * Create a release marker on the configured org. Used by CI to correlate
 * deploys with Sentry's event timeline + activate release-based issue
 * resolution (resolvedInNextRelease).
 */
export async function createRelease(
  client: MgmtClient,
  opts: CreateReleaseOptions,
  organizationSlug?: string,
): Promise<SentryRelease> {
  assertNotReadOnly("sentry/createRelease");
  const org = organizationSlug ?? client.organizationSlug;
  if (!org) throw new Error("organizationSlug required");
  const res = await fetch(
    `${client.host}/api/0/organizations/${encodeURIComponent(org)}/releases/`,
    {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({
        version: opts.version,
        projects: opts.projects,
        refs: opts.refs,
        url: opts.url,
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) {
    throw new Error(`POST .../releases/ returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as SentryRelease;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
