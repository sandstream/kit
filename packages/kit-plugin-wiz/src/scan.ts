/**
 * Wiz issue-graph ingestion. Read-only by design: this plugin ONLY queries
 * Wiz's GraphQL API with read scopes and writes the resulting findings to
 * the local .kit-scan-results.jsonl. It never mutates Wiz state.
 *
 * Auth: Wiz uses a per-tenant service-account flow. The operator obtains a
 * client-id / client-secret pair from the Wiz console (Settings → Service
 * Accounts → New) with the `read:issues` scope only. kit exchanges them
 * for a short-lived access-token via the OAuth2 client_credentials grant.
 *
 * Mirrors Wiz's own product principle: agentless, read-only, no extra data
 * leaves the operator's trust boundary. kit is just a consumer of the
 * issues Wiz already detected.
 *
 * Auth env vars:
 *   WIZ_CLIENT_ID
 *   WIZ_CLIENT_SECRET
 *   WIZ_API_URL          (e.g. https://api.us17.app.wiz.io/graphql)
 *   WIZ_AUTH_URL         (e.g. https://auth.app.wiz.io/oauth/token)
 */

import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

const SCAN_RESULTS_FILE = ".kit-scan-results.jsonl";

export interface WizIssue {
  id: string;
  severity: "INFORMATIONAL" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: string;
  resolutionReason?: string;
  type?: string;
  entitySnapshot?: {
    type?: string;
    name?: string;
    cloudPlatform?: string;
    subscriptionExternalId?: string;
    region?: string;
  };
  controlId?: string;
  controlName?: string;
  createdAt?: string;
}

export interface WizClient {
  apiUrl: string;
  accessToken: string;
}

export interface MakeClientOptions {
  clientId?: string;
  clientSecret?: string;
  apiUrl?: string;
  authUrl?: string;
}

/**
 * Exchange WIZ_CLIENT_ID / WIZ_CLIENT_SECRET for a short-lived bearer token
 * via the OAuth2 client_credentials grant. Token TTL is typically 30 min;
 * caller is responsible for re-minting on expiry (this plugin doesn't
 * cache tokens — each invocation gets a fresh one).
 */
export async function makeClient(opts: MakeClientOptions = {}): Promise<WizClient> {
  const clientId = opts.clientId ?? process.env.WIZ_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.WIZ_CLIENT_SECRET;
  const apiUrl = opts.apiUrl ?? process.env.WIZ_API_URL;
  const authUrl = opts.authUrl ?? process.env.WIZ_AUTH_URL ?? "https://auth.app.wiz.io/oauth/token";
  if (!clientId || !clientSecret) {
    throw new Error("WIZ_CLIENT_ID + WIZ_CLIENT_SECRET required");
  }
  if (!apiUrl) {
    throw new Error("WIZ_API_URL required (tenant-specific, e.g. https://api.us17.app.wiz.io/graphql)");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    audience: "wiz-api",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Wiz auth ${res.status}: ${await safeText(res)}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Wiz auth returned no access_token");
  }
  return { apiUrl, accessToken: data.access_token };
}

const ISSUES_QUERY = `
  query Issues($first: Int!, $filterBy: IssueFilters) {
    issues(first: $first, filterBy: $filterBy) {
      nodes {
        id
        severity
        status
        resolutionReason
        type
        entitySnapshot { type name cloudPlatform subscriptionExternalId region }
        control { id name }
        createdAt
      }
    }
  }
`;

export interface FetchIssuesOptions {
  limit?: number;
  minSeverity?: WizIssue["severity"];
  statusIn?: string[];
}

export async function fetchIssues(
  client: WizClient,
  opts: FetchIssuesOptions = {},
): Promise<WizIssue[]> {
  const variables: {
    first: number;
    filterBy?: { severity?: string[]; status?: string[] };
  } = { first: Math.min(opts.limit ?? 100, 500) };
  if (opts.minSeverity || opts.statusIn) {
    variables.filterBy = {};
    if (opts.minSeverity) {
      variables.filterBy.severity = expandSeverityFloor(opts.minSeverity);
    }
    if (opts.statusIn) variables.filterBy.status = opts.statusIn;
  }
  const res = await fetch(client.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: ISSUES_QUERY, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Wiz GraphQL ${res.status}: ${await safeText(res)}`);
  }
  const body = (await res.json()) as {
    data?: {
      issues?: {
        nodes?: Array<{
          id?: string;
          severity?: WizIssue["severity"];
          status?: string;
          resolutionReason?: string;
          type?: string;
          entitySnapshot?: WizIssue["entitySnapshot"];
          control?: { id?: string; name?: string };
          createdAt?: string;
        }>;
      };
    };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors && body.errors.length) {
    throw new Error(`Wiz GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return (body.data?.issues?.nodes ?? []).map((n) => ({
    id: n.id ?? "",
    severity: n.severity ?? "LOW",
    status: n.status ?? "OPEN",
    resolutionReason: n.resolutionReason,
    type: n.type,
    entitySnapshot: n.entitySnapshot,
    controlId: n.control?.id,
    controlName: n.control?.name,
    createdAt: n.createdAt,
  }));
}

function expandSeverityFloor(min: WizIssue["severity"]): string[] {
  const order: WizIssue["severity"][] = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const idx = order.indexOf(min);
  return idx < 0 ? order : order.slice(idx);
}

/**
 * Append Wiz findings to .kit-scan-results.jsonl. One entry per issue.
 */
export async function recordWizIssues(
  issues: WizIssue[],
  cwd: string = process.cwd(),
): Promise<{ written: number }> {
  if (issues.length === 0) return { written: 0 };
  const path = resolve(cwd, SCAN_RESULTS_FILE);
  const now = new Date().toISOString();
  const lines = issues.map((i) =>
    JSON.stringify({
      timestamp: now,
      source: "wiz",
      severity: i.severity.toLowerCase(),
      id: i.id,
      title: i.controlName ?? i.type ?? i.id,
      entity: i.entitySnapshot
        ? `${i.entitySnapshot.type ?? "?"}/${i.entitySnapshot.name ?? "?"}`
        : undefined,
      cloud_platform: i.entitySnapshot?.cloudPlatform,
      subscription: i.entitySnapshot?.subscriptionExternalId,
      region: i.entitySnapshot?.region,
      status: i.status,
      created_at: i.createdAt,
    }),
  );
  await appendFile(path, lines.join("\n") + "\n", "utf-8");
  return { written: lines.length };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
