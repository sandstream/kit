import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

export interface NpmArtifactFetchPolicy {
  readonly origins: readonly string[];
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly caPem?: string;
}

export type NpmArtifactFetchFailure = Readonly<{
  status: "rejected" | "unsupported";
  reason: string;
  statusCode?: number;
}>;

export type NpmArtifactFetchResult =
  { status: "retrieved"; bytes: Buffer; source: string } | NpmArtifactFetchFailure;

export type NpmArtifactUrlResult =
  { status: "valid"; url: URL; source: string } | NpmArtifactFetchFailure;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** Validate syntax and exact URL spelling. This does not authorize network access. */
export function parseNpmArtifactUrl(resolved: unknown): NpmArtifactUrlResult {
  if (typeof resolved !== "string") return { status: "rejected", reason: "invalid-url" };
  if (resolved.length > 8192) return { status: "unsupported", reason: "url-limit" };
  if (/[\s\\\x00-\x1f\x7f]/.test(resolved) || /%(?![0-9a-f]{2})/i.test(resolved)) {
    return { status: "rejected", reason: "invalid-url" };
  }
  if (/[^\x21-\x7e]/.test(resolved)) return { status: "unsupported", reason: "noncanonical-url" };
  try {
    const url = new URL(resolved);
    if (url.protocol !== "https:") return { status: "unsupported", reason: "unsupported-protocol" };
    const written = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)(.*)$/i.exec(resolved);
    if (!written) return { status: "rejected", reason: "invalid-url" };
    if (written[1].includes("@")) return { status: "rejected", reason: "url-credentials" };
    if (resolved.includes("#")) return { status: "rejected", reason: "url-fragment" };
    const target = written[2].startsWith("/") ? written[2] : "/" + written[2];
    if (
      resolved.slice(0, resolved.length - written[2].length) !== url.origin ||
      url.href !== url.origin + target
    ) {
      return { status: "unsupported", reason: "noncanonical-url" };
    }
    return { status: "valid", url, source: resolved };
  } catch {
    return { status: "rejected", reason: "invalid-url" };
  }
}

type CopiedPolicy = { origins: Set<string>; timeoutMs: number; maxBytes: number; caPem?: string };

function boundedInteger(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function validCaPem(caPem: unknown): boolean {
  return (
    typeof caPem === "string" &&
    caPem.length > 0 &&
    caPem.length <= 262144 &&
    Buffer.byteLength(caPem) <= 262144
  );
}

function copyOrigins(origins: unknown[]): Set<string> | undefined {
  const copied = new Set<string>();
  for (const origin of origins) {
    if (typeof origin !== "string" || origin.length > 2048) return undefined;
    const parsed = parseNpmArtifactUrl(origin);
    if (parsed.status !== "valid" || parsed.url.origin !== origin) return undefined;
    copied.add(origin);
  }
  return copied;
}

function copyPolicy(policy: NpmArtifactFetchPolicy): CopiedPolicy | NpmArtifactFetchFailure {
  const invalid: NpmArtifactFetchFailure = { status: "rejected", reason: "invalid-policy" };
  try {
    if (!policy || typeof policy !== "object") return invalid;
    const { origins, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, caPem } = policy;
    if (!Array.isArray(origins) || origins.length > 32) return invalid;
    if (!boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS)) return invalid;
    if (!boundedInteger(maxBytes, DEFAULT_MAX_BYTES)) return invalid;
    if (caPem !== undefined && !validCaPem(caPem)) return invalid;
    const copied = copyOrigins(origins);
    if (!copied) return invalid;
    return { origins: copied, timeoutMs, maxBytes, caPem };
  } catch {
    return invalid;
  }
}

function checkResponse(
  res: IncomingMessage,
  maxBytes: number,
): { status: "ready"; length?: number } | NpmArtifactFetchFailure {
  const statusCode = res.statusCode;
  if (!Number.isSafeInteger(statusCode)) return { status: "rejected", reason: "invalid-response" };
  if (statusCode! >= 300 && statusCode! <= 399) {
    return { status: "unsupported", reason: "redirect-not-allowed", statusCode };
  }
  if (statusCode !== 200) return { status: "rejected", reason: "http-status", statusCode };
  if (res.headers["content-range"] !== undefined) {
    return { status: "unsupported", reason: "content-range", statusCode };
  }
  const encoding = res.headers["content-encoding"];
  if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
    return { status: "unsupported", reason: "content-encoding", statusCode };
  }
  const declared = res.headers["content-length"];
  if (declared === undefined) return { status: "ready" };
  if (!/^\d+$/.test(declared))
    return { status: "rejected", reason: "invalid-response", statusCode };
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    return { status: "unsupported", reason: "body-limit", statusCode };
  }
  return { status: "ready", length };
}

function requestOptions(url: URL, caPem: string | undefined): RequestOptions {
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || 443,
    path: url.href.slice(url.origin.length),
    method: "GET",
    headers: { "accept-encoding": "identity" },
    rejectUnauthorized: true,
    agent: false,
    ca: caPem,
  };
}

export function fetchNpmTarball(
  resolved: string,
  policy: NpmArtifactFetchPolicy,
): Promise<NpmArtifactFetchResult> {
  const parsed = parseNpmArtifactUrl(resolved);
  if (parsed.status !== "valid") return Promise.resolve(parsed);
  const copied = copyPolicy(policy);
  if ("status" in copied) return Promise.resolve(copied);
  if (!copied.origins.has(parsed.url.origin)) {
    return Promise.resolve({ status: "rejected", reason: "origin-not-allowed" });
  }
  return new Promise((resolve) => {
    let req: ClientRequest | undefined;
    let res: IncomingMessage | undefined;
    let settled = false;
    let body: Buffer | undefined;
    let received = 0;
    const finish = (result: NpmArtifactFetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res?.destroy();
      req?.destroy();
      body = undefined;
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ status: "rejected", reason: "timeout" }),
      copied.timeoutMs,
    );
    try {
      req = request(requestOptions(parsed.url, copied.caPem), (response) => {
        res = response;
        res.on("error", () => finish({ status: "rejected", reason: "response-incomplete" }));
        const checked = checkResponse(res, copied.maxBytes);
        if (checked.status !== "ready") {
          finish(checked);
          return;
        }
        body = Buffer.allocUnsafeSlow(checked.length ?? copied.maxBytes);
        res.on("data", (chunk: Buffer) => {
          if (settled || !body) return;
          if (chunk.length > copied.maxBytes - received) {
            finish({ status: "unsupported", reason: "body-limit", statusCode: 200 });
            return;
          }
          if (chunk.length > body.length - received) {
            finish({ status: "rejected", reason: "response-incomplete" });
            return;
          }
          chunk.copy(body, received);
          received += chunk.length;
        });
        res.on("end", () => {
          if (settled || !body) return;
          finish({
            status: "retrieved",
            bytes: Buffer.from(body.subarray(0, received)),
            source: parsed.source,
          });
        });
      });
      req.on("error", () => finish({ status: "rejected", reason: "request-failed" }));
      req.end();
    } catch {
      finish({ status: "rejected", reason: "request-failed" });
    }
  });
}
