/**
 * Snyk scan-result ingestion. Read-only by design: this plugin NEVER calls
 * Snyk's write APIs (mute, ignore, etc.) and NEVER pushes data anywhere.
 *
 * Two modes:
 *
 *   1. **Parse local snyk-CLI output** — `parseSnykJson(path)` consumes the
 *      JSON file produced by `snyk test --json > snyk-results.json`. The CLI
 *      runs in the operator's existing CI/local env; kit just reads the
 *      output and surfaces findings to its own scan-results log.
 *
 *   2. **Fetch from Snyk API (read-only)** — `fetchSnykIssues({ token,
 *      orgSlug, projectId })` pulls the latest scan results via the Snyk
 *      REST API. Only GET endpoints. Token comes from the operator's vault
 *      via SNYK_TOKEN env var.
 *
 * Both paths append findings to .kit-scan-results.jsonl in the project
 * root so `kit check --security` can gate on them.
 *
 * Mirrors the Wiz-tier "agentless, read-only, no data leaves" principle: the
 * plugin reads, kit consumes, nothing is sent to Snyk that wasn't already
 * there.
 */

import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

const SCAN_RESULTS_FILE = ".kit-scan-results.jsonl";
const DEFAULT_API_BASE = "https://api.snyk.io";

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

export interface SnykVulnerability {
  id: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  packageName?: string;
  packageVersion?: string;
  fixedIn?: string[];
  cvssScore?: number;
  cwe?: string[];
}

export interface SnykResult {
  vulnerabilities: SnykVulnerability[];
  ok: boolean;
  projectName?: string;
  uniqueCount?: number;
  coverage?: "partial";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function severityOf(value: unknown): SnykVulnerability["severity"] {
  return value === "critical" || value === "high" || value === "medium" ? value : "low";
}

/**
 * Parse the JSON file produced by `snyk test --json`. Tolerant of both
 * single-project and multi-project (`--all-projects`) outputs.
 */
export function parseSnykJson(text: string): SnykResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // See sentrux/scan.ts: the underlying parse error is the only thing that says WHERE
    // the output went wrong, and a scanner must not discard it.
    throw new Error(`Invalid Snyk JSON: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    });
  }
  const projects = Array.isArray(parsed) ? parsed : [parsed];
  const results = projects.map(normalizeSnykResult);
  const partial = results.some((result) => result.coverage === "partial");
  if (!results.length || (partial && results.every((result) => !result.vulnerabilities.length))) {
    throw new Error("Incomplete Snyk report: no findings could be retained");
  }
  return results;
}

function normalizeSnykResult(raw: unknown): SnykResult {
  const r = (record(raw) ?? {}) as {
    vulnerabilities?: Array<{
      id?: string;
      title?: string;
      severity?: string;
      packageName?: string;
      version?: string;
      fixedIn?: string[];
      cvssScore?: number;
      identifiers?: { CWE?: string[] };
    }>;
    ok?: boolean;
    projectName?: string;
    uniqueCount?: number;
  };
  const entries = Array.isArray(r.vulnerabilities) ? r.vulnerabilities : [];
  const vulnerabilities = entries.flatMap((v) => {
    const id = textField(v?.id);
    if (!id) return [];
    return [
      {
        id,
        title: textField(v.title) ?? "(no title)",
        severity: severityOf(v.severity),
        packageName: textField(v.packageName),
        packageVersion: textField(v.version),
        fixedIn: Array.isArray(v.fixedIn)
          ? v.fixedIn.filter((entry) => typeof entry === "string")
          : undefined,
        cvssScore: typeof v.cvssScore === "number" ? v.cvssScore : undefined,
        cwe: Array.isArray(v.identifiers?.CWE)
          ? v.identifiers.CWE.filter((entry) => typeof entry === "string")
          : undefined,
      },
    ];
  });
  const partial =
    !Array.isArray(r.vulnerabilities) ||
    typeof r.ok !== "boolean" ||
    (r.ok === false && entries.length === 0) ||
    entries.length !== vulnerabilities.length;
  return {
    vulnerabilities,
    ok: !partial && r.ok === true,
    projectName: textField(r.projectName),
    uniqueCount: typeof r.uniqueCount === "number" ? r.uniqueCount : undefined,
    ...(partial ? { coverage: "partial" as const } : {}),
  };
}

/**
 * Append Snyk findings to .kit-scan-results.jsonl. One entry per
 * vulnerability so downstream tools (kit check --security) can filter
 * by severity / cvssScore.
 */
export async function recordSnykFindings(
  results: SnykResult[],
  cwd: string = process.cwd(),
): Promise<{ written: number; coverage?: "partial" }> {
  const path = resolve(cwd, SCAN_RESULTS_FILE);
  const now = new Date().toISOString();
  const lines: string[] = [];
  for (const r of results) {
    for (const v of r.vulnerabilities) {
      lines.push(
        JSON.stringify({
          timestamp: now,
          source: "snyk",
          project: r.projectName,
          severity: v.severity,
          id: v.id,
          title: v.title,
          package: v.packageName,
          version: v.packageVersion,
          fixed_in: v.fixedIn,
          cvss: v.cvssScore,
          cwe: v.cwe,
        }),
      );
    }
  }
  const partial = results.some((result) => result.coverage === "partial");
  if (lines.length === 0) {
    if (partial) throw new Error("Incomplete Snyk report: no findings could be retained");
    return { written: 0 };
  }
  await appendFile(path, lines.join("\n") + "\n", "utf-8");
  return { written: lines.length, ...(partial ? { coverage: "partial" as const } : {}) };
}

export interface FetchSnykIssuesOptions {
  /** Snyk API token (read-only is sufficient). Defaults to SNYK_TOKEN env var. */
  token?: string;
  /** Snyk org slug or UUID. Required. */
  orgSlug: string;
  /** Project ID to fetch issues for. Optional — defaults to org-wide. */
  projectId?: string;
  /** API base URL. EU customers may want https://api.eu.snyk.io. */
  apiBase?: string;
}

export class IncompleteSnykIssuesError extends Error {
  constructor(
    readonly findings: SnykVulnerability[],
    cause: unknown,
  ) {
    super("Snyk issue coverage is incomplete", { cause });
    this.name = "IncompleteSnykIssuesError";
  }
}

/**
 * Read-only Snyk API fetch. Uses `GET /rest/orgs/{org}/issues`. Throws on
 * unauthorized — caller surfaces to the user instead of silently failing.
 */
export async function fetchSnykIssues(opts: FetchSnykIssuesOptions): Promise<SnykVulnerability[]> {
  const token = opts.token ?? process.env.SNYK_TOKEN;
  if (!token) throw new Error("SNYK_TOKEN not set");
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const params = new URLSearchParams({ version: "2024-10-15" });
  if (opts.projectId) params.set("scan_item.id", opts.projectId);
  const firstUrl = new URL(
    `${base}/rest/orgs/${encodeURIComponent(opts.orgSlug)}/issues?${params}`,
  );
  let url: URL | undefined = firstUrl;
  const seen = new Set<string>();
  const findings: SnykVulnerability[] = [];
  try {
    while (url) {
      if (seen.has(url.href) || seen.size >= 100) {
        throw new Error("Snyk API pagination did not finish within 100 distinct pages");
      }
      seen.add(url.href);
      const page = await readSnykIssuePage(url, token);
      findings.push(...page.findings);
      if (page.malformed) throw new Error("Invalid Snyk API issue response");
      url = nextSnykPage(url, page.next, firstUrl);
    }
  } catch (error) {
    if (findings.length) throw new IncompleteSnykIssuesError(findings, error);
    throw error;
  }
  return findings;
}

const SNYK_PAGING_PARAMETERS = new Set(["starting_after", "ending_before", "limit"]);

function nextSnykPage(current: URL, next: unknown, first: URL): URL | undefined {
  if (next === undefined || next === null) return undefined;
  const href = textField(typeof next === "string" ? next : record(next)?.href);
  if (!href) throw new Error("Invalid Snyk API pagination link");
  const url = URL.parse(href, current);
  if (
    !url ||
    url.origin !== first.origin ||
    url.pathname !== first.pathname ||
    url.username ||
    url.password
  ) {
    throw new Error("Snyk API pagination link changes the issue endpoint");
  }
  preserveSnykPageScope(url, first);
  url.hash = "";
  return url;
}

function preserveSnykPageScope(url: URL, first: URL): void {
  for (const [key, value] of url.searchParams) {
    if (!SNYK_PAGING_PARAMETERS.has(key) && first.searchParams.get(key) !== value)
      throw new Error("Snyk API pagination link changes the issue scope");
  }
  for (const [key, value] of first.searchParams) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
}

async function readSnykIssuePage(url: URL, token: string) {
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.api+json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Snyk API ${res.status}: ${await safeText(res, [token])}`);
  }
  const body = record(await res.json());
  if (!Array.isArray(body?.data))
    throw new Error("Invalid Snyk API response: expected a data array");
  const findings = body.data.flatMap(readSnykIssue);
  const links = record(body.links);
  const version = record(body.jsonapi)?.version;
  const malformed =
    typeof version !== "string" ||
    !/^1\.(0|[1-9]\d*)$/.test(version) ||
    body.data.length !== findings.length ||
    (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length > 0)) ||
    (body.links !== undefined && !links);
  return { findings, malformed, next: links?.next };
}

function firstRecord(value: unknown) {
  return Array.isArray(value) ? record(value[0]) : undefined;
}

function readSnykIssue(raw: unknown): SnykVulnerability[] {
  const issue = record(raw);
  const attributes = record(issue?.attributes);
  const id = textField(issue?.id);
  if (!id || !attributes) return [];
  const coordinate = firstRecord(attributes.coordinates);
  const representation = firstRecord(coordinate?.representations);
  const dep = record(representation?.dependency);
  return [
    {
      id,
      title: textField(attributes.title) ?? "(no title)",
      severity: severityOf(attributes.effective_severity_level),
      packageName: textField(dep?.package_name),
      packageVersion: textField(dep?.package_version),
    },
  ];
}

async function safeText(res: Response, knownSecrets: readonly string[]): Promise<string> {
  try {
    return redactErrorText(await res.text(), knownSecrets).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
