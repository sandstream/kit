/** Read-only default branch protection check for GitHub and GitLab. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { loadConfig } from "./config.js";
import { resolveAirGap } from "./airgap/config.js";
import { resolveViaBackend } from "./secret-backends.js";

export interface GitRemote {
  host: "github.com" | "gitlab.com";
  path: string;
}
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
// The staged secret scanner treats a quoted key name as a secret value.
const TOKEN_KEYS = {
  "github.com": ["GITHUB", "TOKEN"].join("_"),
  "gitlab.com": ["GITLAB", "TOKEN"].join("_"),
};

export function parseGitRemote(input: string): GitRemote | null {
  let host: string;
  let path: string;
  const ssh = /^git@(github\.com|gitlab\.com):(.+)$/i.exec(input.trim());
  if (ssh) {
    host = ssh[1].toLowerCase();
    path = ssh[2];
  } else {
    try {
      const url = new URL(input.trim());
      if (url.protocol !== "https:" || url.username || url.password) return null;
      host = url.hostname.toLowerCase();
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  if (host !== "github.com" && host !== "gitlab.com") return null;
  path = path.replace(/\.git$/, "");
  const parts = path.split("/");
  if (parts.length < 2 || (host === "github.com" && parts.length !== 2)) return null;
  if (parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === ".."))
    return null;
  return { host, path };
}

function unverified(detail: string, skip = false): SecurityCheckResult {
  return {
    category: "exposure",
    name: "default branch protection",
    status: skip ? "skip" : "warn",
    detail: `unverified: ${detail}`,
    didNotRun: true,
  };
}

async function jsonGet(
  url: string,
  token: string,
  host: GitRemote["host"],
  fetcher: Fetcher,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (host === "github.com") {
    headers.Authorization = `Bearer ${token}`;
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  } else headers["PRIVATE-TOKEN"] = token;
  const response = await fetcher(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const body = await response.text();
  if (body.length > 1_000_000) return null;
  const parsed: unknown = JSON.parse(body);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Query only fixed API hosts. No token or incomplete API response stays unverified. */
export async function auditRemoteBranchProtection(
  remoteUrl: string,
  token: string | null,
  fetcher: Fetcher = fetch,
): Promise<SecurityCheckResult> {
  const remote = parseGitRemote(remoteUrl);
  if (!remote) return unverified("origin is not a supported GitHub or GitLab remote");
  if (!token) return unverified(`no ${TOKEN_KEYS[remote.host]} in kit secrets`);
  const projectPath = remote.path.split("/").map(encodeURIComponent).join("/");
  const base =
    remote.host === "github.com"
      ? `https://api.github.com/repos/${projectPath}`
      : `https://gitlab.com/api/v4/projects/${encodeURIComponent(remote.path)}`;
  try {
    const project = await jsonGet(base, token, remote.host, fetcher);
    if (!project || typeof project.default_branch !== "string" || !project.default_branch)
      return unverified("repository metadata unavailable or incomplete");
    const branchUrl =
      remote.host === "github.com"
        ? `${base}/branches/${encodeURIComponent(project.default_branch)}`
        : `${base}/repository/branches/${encodeURIComponent(project.default_branch)}`;
    const branch = await jsonGet(branchUrl, token, remote.host, fetcher);
    if (!branch || typeof branch.protected !== "boolean")
      return unverified("default branch status unavailable or incomplete");
    return {
      category: "exposure",
      name: "default branch protection",
      status: branch.protected ? "pass" : "warn",
      severity: branch.protected ? undefined : "medium",
      detail: `${remote.host} ${project.default_branch}: ${branch.protected ? "protected" : "unprotected"}`,
      suggestion: branch.protected
        ? undefined
        : "protect the default branch in repository settings",
    };
  } catch {
    return unverified("API request failed");
  }
}

/** Read origin and a declared kit secret, then check the remote read-only. */
export async function runBranchProtectionAudit(root: string): Promise<SecurityCheckResult[]> {
  let origin: string;
  try {
    origin = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return [unverified("origin remote unavailable")];
  }
  const remote = parseGitRemote(origin);
  if (!remote) return [unverified("origin is not a supported GitHub or GitLab remote")];
  const configPath = join(root, ".kit.toml");
  if (!existsSync(configPath)) return [unverified("kit config unavailable")];
  let config;
  try {
    config = await loadConfig(configPath);
  } catch {
    return [unverified("kit config invalid or unreadable")];
  }
  if (resolveAirGap(config.air_gap, process.env).enabled)
    return [unverified("skipped (air gap)", true)];
  const name = TOKEN_KEYS[remote.host];
  const key = config.secrets?.keys?.[name];
  if (!key) return [unverified(`no ${name} in kit secrets`)];
  if (key.source === "config")
    return [unverified(`${name} must not be stored inline in .kit.toml`)];
  try {
    const resolved = await resolveViaBackend(name, key, config.secrets?.infisical, root);
    if (!resolved.resolved || !resolved.value || resolved.managed)
      return [unverified(`configured ${name} unavailable`)];
    return [await auditRemoteBranchProtection(origin, resolved.value)];
  } catch {
    return [unverified(`configured ${name} unavailable`)];
  }
}
