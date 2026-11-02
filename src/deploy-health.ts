/**
 * Deployed commit, read from the running service (Z4 part 1).
 *
 *   [deploy.health.production]
 *   url = "https://www.example.com/api/version"
 *   version_field = "version"        # optional, dot path into the JSON, default "version"
 *
 * One GET per target, no credential, no redirect, 64 KB cap. A value that is not a commit
 * hash (for example "dev") is unverified, never a pass. The URL comes from the repository, so
 * the read is opt-in (`--online`), makes no request in air-gap mode, and refuses private,
 * link-local and metadata addresses. The address check resolves the name once and fetch
 * resolves it again, so a DNS answer that changes between the two is not covered.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
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
  /** The caller opted in to outbound reads (`--online`). Without it nothing is requested. */
  online: boolean;
  timeoutMs?: number;
  /** Tests only: allow plain http to the literal loopback address 127.0.0.1 or ::1. */
  allowLoopback?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(net, bits, "ipv6");
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:hhhh:hhhh). */
function mappedV4(address: string): string | null {
  const prefix = "::ffff:";
  if (!address.toLowerCase().startsWith(prefix)) return null;
  const rest = address.slice(prefix.length);
  if (isIP(rest) === 4) return rest;
  const groups = rest.split(":");
  if (groups.length !== 2 || !groups.every((g) => g.length >= 1 && g.length <= 4)) return null;
  const [hi, lo] = groups.map((g) => parseInt(g, 16));
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const inner = mappedV4(address);
    if (inner) return isPrivateAddress(inner);
    return PRIVATE.check(address, "ipv6");
  }
  return PRIVATE.check(address, "ipv4");
}

/** True when every address the host resolves to is public (or loopback, when allowed). */
async function resolvesPublic(url: URL, allowLoopback: boolean): Promise<boolean> {
  const host = bareHost(url);
  if (allowLoopback && LOOPBACK.has(host)) return true;
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const found = await lookup(host, { all: true });
    return found.length > 0 && found.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

function row(
  environment: string,
  status: DeployCheckResult["status"],
  detail: string,
  extra: Partial<DeployHealthRow> = {},
): DeployHealthRow {
  return { provider: "health", environment, project: "-", status, detail, ...extra };
}

function parseTarget(
  environment: string,
  raw: unknown,
  allowLoopback: boolean,
): DeployHealthTarget | DeployHealthRow {
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
  const loopbackHttp =
    allowLoopback && parsed.protocol === "http:" && LOOPBACK.has(bareHost(parsed));
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    return row(environment, "warn", `[deploy.health.${environment}] url must use https`);
  }
  const field = typeof table.version_field === "string" ? table.version_field : "version";
  return { environment, url, versionField: field };
}

export function parseDeployHealth(
  config: object | undefined,
  allowLoopback = false,
): DeployHealthParse {
  const health = (config as { health?: unknown } | undefined)?.health;
  if (!health || typeof health !== "object") return { targets: [], errors: [] };
  const targets: DeployHealthTarget[] = [];
  const errors: DeployHealthRow[] = [];
  for (const [environment, raw] of Object.entries(health)) {
    const parsed = parseTarget(environment, raw, allowLoopback);
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

async function readTarget(
  target: DeployHealthTarget,
  timeoutMs: number,
  allowLoopback: boolean,
): Promise<DeployHealthRow> {
  const unverified = (why: string) =>
    row(target.environment, "warn", `unverified: ${why} (${target.url})`, { didNotRun: true });
  if (!(await resolvesPublic(new URL(target.url), allowLoopback))) {
    return unverified("the host is not a public address, kit does not read it");
  }
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
  const allowLoopback = opts.allowLoopback === true;
  const { targets, errors } = parseDeployHealth(config, allowLoopback);
  const skipped = (why: string) =>
    targets.map((t) => row(t.environment, "skip", `${why}: the deployed commit was not read`));
  if (opts.airGap) return [...errors, ...skipped("air-gap mode")];
  if (!opts.online) return [...errors, ...skipped("run with --online to read it")];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const read = await Promise.all(targets.map((t) => readTarget(t, timeoutMs, allowLoopback)));
  return [...errors, ...read];
}
