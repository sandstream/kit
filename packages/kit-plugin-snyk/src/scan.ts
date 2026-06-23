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
    throw new Error(`Invalid Snyk JSON: ${err instanceof Error ? err.message : err}`);
  }
  // multi-project: Snyk returns an array of result objects.
  if (Array.isArray(parsed)) {
    return parsed.map(normalizeSnykResult);
  }
  return [normalizeSnykResult(parsed)];
}

function normalizeSnykResult(raw: unknown): SnykResult {
  if (!raw || typeof raw !== "object") {
    return { vulnerabilities: [], ok: true };
  }
  const r = raw as {
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
  return {
    vulnerabilities: (r.vulnerabilities ?? []).map((v) => ({
      id: v.id ?? "",
      title: v.title ?? "(no title)",
      severity: (v.severity as SnykVulnerability["severity"]) ?? "low",
      packageName: v.packageName,
      packageVersion: v.version,
      fixedIn: v.fixedIn,
      cvssScore: v.cvssScore,
      cwe: v.identifiers?.CWE,
    })),
    ok: r.ok ?? false,
    projectName: r.projectName,
    uniqueCount: r.uniqueCount,
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
): Promise<{ written: number }> {
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
  if (lines.length === 0) return { written: 0 };
  await appendFile(path, lines.join("\n") + "\n", "utf-8");
  return { written: lines.length };
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
  const url = `${base}/rest/orgs/${encodeURIComponent(opts.orgSlug)}/issues?${params}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.api+json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Snyk API ${res.status}: ${await safeText(res)}`);
  }
  const body = (await res.json()) as {
    data?: Array<{
      id?: string;
      attributes?: {
        title?: string;
        effective_severity_level?: string;
        coordinates?: Array<{
          representations?: Array<{
            dependency?: { package_name?: string; package_version?: string };
          }>;
        }>;
      };
    }>;
  };
  return (body.data ?? []).map((iss) => {
    const dep = iss.attributes?.coordinates?.[0]?.representations?.[0]?.dependency;
    return {
      id: iss.id ?? "",
      title: iss.attributes?.title ?? "(no title)",
      severity:
        (iss.attributes?.effective_severity_level as SnykVulnerability["severity"]) ?? "low",
      packageName: dep?.package_name,
      packageVersion: dep?.package_version,
    };
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
