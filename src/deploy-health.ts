/**
 * Deployed commit, read from the running service (Z4 part 1).
 *
 *   [deploy.health.production]
 *   url = "https://www.example.com/api/version"
 *   version_field = "version"        # optional, dot path into the JSON, default "version"
 *
 * One GET per target, no credential, no redirect, 64 KB cap. A value that is not a commit
 * hash (for example "dev") is unverified, never a pass. Air-gap mode makes no request.
 */
import type { DeployCheckResult } from "./check-deploy.js";

export interface DeployHealthTarget {
  environment: string;
  url: string;
  versionField: string;
}

export interface DeployHealthParse {
  targets: DeployHealthTarget[];
  errors: DeployCheckResult[];
}

export interface DeployHealthRow extends DeployCheckResult {
  commit?: string;
}

export interface DeployHealthOptions {
  airGap: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function row(
  environment: string,
  status: DeployCheckResult["status"],
  detail: string,
  extra: Partial<DeployHealthRow> = {},
): DeployHealthRow {
  return { provider: "health", environment, project: "-", status, detail, ...extra };
}

function parseTarget(environment: string, raw: unknown): DeployHealthTarget | DeployHealthRow {
  const table = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const url = table.url;
  if (typeof url !== "string" || url === "") {
    return row(environment, "warn", `[deploy.health.${environment}] needs a url`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return row(environment, "warn", `[deploy.health.${environment}] url is not a valid URL`);
  }
  if (parsed.username || parsed.password) {
    return row(environment, "warn", `[deploy.health.${environment}] url must not hold credentials`);
  }
  const loopbackHttp = parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    return row(environment, "warn", `[deploy.health.${environment}] url must use https`);
  }
  const field = typeof table.version_field === "string" ? table.version_field : "version";
  return { environment, url, versionField: field };
}

export function parseDeployHealth(config: object | undefined): DeployHealthParse {
  const health = (config as { health?: unknown } | undefined)?.health;
  if (!health || typeof health !== "object") return { targets: [], errors: [] };
  const targets: DeployHealthTarget[] = [];
  const errors: DeployHealthRow[] = [];
  for (const [environment, raw] of Object.entries(health)) {
    const parsed = parseTarget(environment, raw);
    if ("url" in parsed && "versionField" in parsed) targets.push(parsed);
    else errors.push(parsed);
  }
  return { targets, errors };
}

function pick(value: unknown, path: string): unknown {
  let node = value;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

async function readCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readTarget(target: DeployHealthTarget, timeoutMs: number): Promise<DeployHealthRow> {
  const unverified = (why: string) =>
    row(target.environment, "warn", `unverified: ${why} (${target.url})`, { didNotRun: true });
  let res: Response;
  try {
    res = await fetch(target.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch {
    return unverified("the endpoint did not answer");
  }
  if (res.status >= 300 && res.status < 400)
    return unverified("the endpoint redirects, kit does not follow a redirect");
  if (!res.ok) return unverified(`the endpoint answered HTTP ${res.status}`);
  const body = await readCapped(res).catch(() => null);
  if (body === null) return unverified("the response is larger than 64 KB");
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return unverified("the response is not JSON");
  }
  const value = pick(data, target.versionField);
  if (typeof value !== "string" || !COMMIT_RE.test(value)) {
    return unverified(`"${target.versionField}" is not a commit hash`);
  }
  return row(target.environment, "pass", `deployed commit ${value.slice(0, 7)}`, { commit: value });
}

export async function checkDeployHealth(
  config: object | undefined,
  opts: DeployHealthOptions,
): Promise<DeployHealthRow[]> {
  const { targets, errors } = parseDeployHealth(config);
  if (opts.airGap) {
    return [
      ...errors,
      ...targets.map((t) =>
        row(t.environment, "skip", "air-gap mode: the deployed commit was not read"),
      ),
    ];
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const read = await Promise.all(targets.map((t) => readTarget(t, timeoutMs)));
  return [...errors, ...read];
}
