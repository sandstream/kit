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

const ERROR_SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{20,}/g,
  /\bwhsec_[A-Za-z0-9]{20,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}/g,
  /\bsk-(?:proj|ant|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

function redactErrorText(input: string, knownSecrets: readonly string[] = []): string {
  let output = input;
  for (const value of [...new Set(knownSecrets)].filter((value) => value.length >= 8)) {
    output = output.split(value).join("[REDACTED]");
  }
  for (const pattern of ERROR_SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  // Core URL/Bearer parity is tested by src/plugin-error-redaction.test.ts.
  return output
    .replace(/\b([a-z][a-z0-9+.-]{0,15}:\/\/[^\s:@/]{0,128}:)[^\s@/]{3,256}@/gi, "$1[REDACTED]@")
    .replace(/\b([a-z][a-z0-9+.-]{0,15}:\/\/)[A-Za-z0-9._~%+-]{16,256}@/gi, "$1[REDACTED]@")
    .replace(
      /\b((?:token|access_token|api_key|apikey|auth_token|session_token)=)[A-Za-z0-9_\-+/%.]{12,}/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9_\-+/.=]{16,}/gi, "Bearer [REDACTED]");
}

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
    throw new Error(
      "WIZ_API_URL required (tenant-specific, e.g. https://api.us17.app.wiz.io/graphql)",
    );
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
    throw new Error(`Wiz auth ${res.status}: ${await safeText(res, [clientSecret])}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Wiz auth returned no access_token");
  }
  return { apiUrl, accessToken: data.access_token };
}

const ISSUES_QUERY = `
  query Issues($first: Int!, $after: String, $filterBy: IssueFilters) {
    issues(first: $first, after: $after, filterBy: $filterBy) {
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
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export interface FetchIssuesOptions {
  limit?: number;
  minSeverity?: WizIssue["severity"];
  statusIn?: string[];
}

export class IncompleteWizIssuesError extends Error {
  constructor(
    readonly findings: WizIssue[],
    cause: unknown,
  ) {
    super("Wiz issue coverage is incomplete", { cause });
    this.name = "IncompleteWizIssuesError";
  }
}

interface IssueVariables {
  first: number;
  after?: string;
  filterBy?: { severity?: string[]; status?: string[] };
}

function issueVariables(limit: number, opts: FetchIssuesOptions): IssueVariables {
  if (!opts.minSeverity && !opts.statusIn) return { first: limit };
  const filterBy: IssueVariables["filterBy"] = {};
  if (opts.minSeverity) filterBy.severity = expandSeverityFloor(opts.minSeverity);
  if (opts.statusIn) filterBy.status = opts.statusIn;
  return { first: limit, filterBy };
}

export async function fetchIssues(
  client: WizClient,
  opts: FetchIssuesOptions = {},
): Promise<WizIssue[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  if (!Number.isInteger(limit) || limit <= 0)
    throw new Error("Wiz issue limit must be a positive integer");
  const variables = issueVariables(limit, opts);
  const findings: WizIssue[] = [];
  const cursors = new Set<string>();
  try {
    for (;;) {
      const page = await readWizPage(client, variables);
      findings.push(...page.findings.slice(0, limit - findings.length));
      if (page.error) throw page.error;
      if (!page.hasNextPage) return findings;
      if (findings.length >= limit) throw new Error("Wiz issue limit reached before the last page");
      const cursor = page.endCursor;
      if (!cursor || cursors.has(cursor) || !page.findings.length) {
        throw new Error("Invalid Wiz API pagination cursor");
      }
      cursors.add(cursor);
      variables.after = cursor;
      variables.first = limit - findings.length;
    }
  } catch (error) {
    if (findings.length) throw new IncompleteWizIssuesError(findings, error);
    throw error;
  }
}

async function readWizPage(client: WizClient, variables: IssueVariables) {
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
    throw new Error(`Wiz GraphQL ${res.status}: ${await safeText(res, [client.accessToken])}`);
  }
  return decodeWizPage(await res.json(), variables.first, client.accessToken);
}

function decodeWizPage(raw: unknown, limit: number, accessToken: string) {
  const body = raw as {
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
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
    errors?: Array<{ message?: string }>;
  };
  const { nodes, pageInfo } = body?.data?.issues ?? {};
  const knownSeverities: string[] = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const findings = (Array.isArray(nodes) ? nodes : []).flatMap((node): WizIssue[] => {
    if (
      !node ||
      typeof node.id !== "string" ||
      !node.id.trim() ||
      !node.severity ||
      !knownSeverities.includes(node.severity) ||
      typeof node.status !== "string" ||
      !node.status.trim()
    )
      return [];
    return [
      {
        id: node.id,
        severity: node.severity,
        status: node.status,
        resolutionReason: node.resolutionReason,
        type: node.type,
        entitySnapshot: node.entitySnapshot,
        controlId: node.control?.id,
        controlName: node.control?.name,
        createdAt: node.createdAt,
      },
    ];
  });
  const invalid =
    !Array.isArray(nodes) ||
    findings.length !== nodes.length ||
    nodes.length > limit ||
    typeof pageInfo?.hasNextPage !== "boolean";
  return {
    findings,
    hasNextPage: pageInfo?.hasNextPage,
    endCursor: typeof pageInfo?.endCursor === "string" ? pageInfo.endCursor : undefined,
    error: wizPageError(body?.errors, invalid, accessToken),
  };
}

function wizPageError(errors: unknown, invalid: boolean, accessToken: string): Error | undefined {
  if (Array.isArray(errors) && errors.length) {
    return new Error(
      `Wiz GraphQL errors: ${redactErrorText(errors.map((e) => e?.message).join("; "), [accessToken])}`,
    );
  }
  if (invalid || (errors !== undefined && !Array.isArray(errors))) {
    return new Error("Invalid Wiz GraphQL issue response");
  }
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

async function safeText(res: Response, knownSecrets: readonly string[]): Promise<string> {
  try {
    return redactErrorText(await res.text(), knownSecrets).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
