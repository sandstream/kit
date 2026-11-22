import { isUtf8 } from "node:buffer";
import {
  ALPINE_SOURCE_MAX_BYTES,
  AlpineSourceError,
  type AlpineSourceResponse,
  type ApkFetcher,
} from "./check-apk-fetch.js";
import { mergeApkIndexOrigins, parseApkIndexOrigins } from "./alpine-index-origins.js";
import { ApkIndexFormatError } from "./alpine-index-archive.js";
import { verifyApkIndex, type ApkIndexKeys } from "./alpine-index-signature.js";
import { mergeSecdb, readSecdbSource, type AlpineRepository } from "./alpine-secdb.js";
import { newestStableBranch } from "./dockerfile-apk-floors.js";
import { sanitizeDisplayText } from "./display-text.js";
import type { ScannerEvidenceStatus, ScannerReportGap } from "./check-scanner-evidence.js";

const SECDB = "https://secdb.alpinelinux.org";
const CDN = "https://dl-cdn.alpinelinux.org/alpine";
const REPOSITORIES = ["main", "community"] as const;
const ARCHITECTURE = "x86_64";
const MAX_SOURCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

type SourceScope =
  | { kind: "branch-list"; url: string }
  | { kind: "secdb"; url: string; branch: string; repository: AlpineRepository }
  | {
      kind: "apkindex";
      url: string;
      branch: string;
      repository: AlpineRepository;
      architecture: "x86_64";
    };

type SourceSuccess = "complete" | "complete-empty";
type SourceGap = ScannerReportGap | "stale";
type SourcePublication = { lastModified?: string; signedAt?: string; signingKey?: string };
type SourceGood = SourceScope & SourcePublication & { status: SourceSuccess };
type SourceBad = SourceScope & SourcePublication & { status: SourceGap; reason: string };
export type AlpineSourceEvidence = SourceGood | SourceBad;

type ReadSource<T> = { evidence: SourceGood; data: T } | { evidence: SourceBad };

function sourceLabel(scope: SourceScope): string {
  if (scope.kind === "branch-list") return "latest Alpine branch";
  const name = scope.kind === "secdb" ? "secdb" : `APKINDEX (${scope.architecture})`;
  return `${scope.branch} ${scope.repository} ${name}`;
}

export function alpineSourceFailure(error: unknown, context: string): string {
  const detail = sanitizeDisplayText(error instanceof Error ? error.message : String(error)).slice(
    0,
    240,
  );
  return `${detail || "source unavailable"} (${context})`;
}

function sourceRefusal(
  scope: SourceScope,
  error: unknown,
  fallback: SourceGap,
  publication: SourcePublication = {},
): ReadSource<never> {
  const status =
    error instanceof AlpineSourceError || error instanceof ApkIndexFormatError
      ? error.status
      : fallback;
  return {
    evidence: {
      ...scope,
      ...publication,
      status,
      reason: alpineSourceFailure(error, sourceLabel(scope)),
    },
  };
}

function readPublicationTime(lastModified: string | null): number {
  if (!lastModified) throw new AlpineSourceError("missing HTTP Last-Modified", "missing");
  const time = Date.parse(lastModified);
  if (!Number.isFinite(time) || new Date(time).toUTCString() !== lastModified)
    throw new AlpineSourceError("invalid HTTP Last-Modified", "malformed");
  return time;
}

function requireCurrentPublication(time: number, label: string): void {
  const age = Date.now() - time;
  if (age < -MAX_CLOCK_SKEW_MS)
    throw new AlpineSourceError(`${label} is more than five minutes in the future`, "malformed");
  if (age > MAX_SOURCE_AGE_MS)
    throw new AlpineSourceError(`${label} is more than 30 days old`, "stale");
}

async function readSource<T extends { size: number } | string>(
  fetcher: ApkFetcher,
  scope: SourceScope,
  parse: (body: Buffer, publication: SourcePublication) => T,
): Promise<ReadSource<T>> {
  let response: AlpineSourceResponse;
  try {
    response = await fetcher(scope.url);
  } catch (error) {
    return sourceRefusal(scope, error, "unavailable");
  }
  if (!response.body.length) return sourceRefusal(scope, "empty response body", "missing");
  const publication: SourcePublication = {};
  try {
    if (scope.kind !== "branch-list") {
      const time = readPublicationTime(response.lastModified);
      publication.lastModified = new Date(time).toISOString();
      requireCurrentPublication(time, "HTTP Last-Modified");
    }
    const data = parse(response.body, publication);
    const count = typeof data === "string" ? data.length : data.size;
    return {
      data,
      evidence: { ...scope, ...publication, status: count ? "complete" : "complete-empty" },
    };
  } catch (error) {
    return sourceRefusal(scope, error, "malformed", publication);
  }
}

function requireBranch(description: Buffer | undefined, branch: string): void {
  if (!description?.length) throw new AlpineSourceError("APKINDEX has no DESCRIPTION", "missing");
  if (description.length > 256 || !isUtf8(description))
    throw new AlpineSourceError("invalid APKINDEX DESCRIPTION", "malformed");
  const version = /^(v\d+\.\d+)\.\d+(?:-\d+-g[\da-f]{7,40})?$/.exec(
    description.toString("utf8").trim(),
  );
  if (!version) throw new AlpineSourceError("unsupported APKINDEX DESCRIPTION", "unsupported");
  if (version[1] !== branch)
    throw new AlpineSourceError("APKINDEX DESCRIPTION names a different branch", "malformed");
}

function readIndexOrigins(
  body: Buffer,
  branch: string,
  publication: SourcePublication,
  keys?: ApkIndexKeys,
): Map<string, string> {
  const { text, description, mtime, signingKey } = verifyApkIndex(body, keys);
  publication.signingKey = signingKey;
  const signedAt = new Date((mtime ?? 0) * 1000);
  if (!Number.isFinite(signedAt.getTime()) || signedAt.getTime() <= 0)
    throw new AlpineSourceError("invalid signed APKINDEX timestamp", "malformed");
  publication.signedAt = signedAt.toISOString();
  requireCurrentPublication(signedAt.getTime(), "Signed APKINDEX timestamp");
  requireBranch(description, branch);
  return parseApkIndexOrigins(text, ARCHITECTURE);
}

async function readRepository(
  branch: string,
  repository: AlpineRepository,
  fetcher: ApkFetcher,
  keys?: ApkIndexKeys,
) {
  const root = `${branch}/${repository}`;
  const [secdb, index] = await Promise.all([
    readSource(
      fetcher,
      {
        kind: "secdb",
        url: `${SECDB}/${root}.json`,
        branch,
        repository,
      },
      (body) => readSecdbSource(body, { branch, repository }, ALPINE_SOURCE_MAX_BYTES),
    ),
    readSource(
      fetcher,
      {
        kind: "apkindex",
        url: `${CDN}/${root}/${ARCHITECTURE}/APKINDEX.tar.gz`,
        branch,
        repository,
        architecture: ARCHITECTURE,
      },
      (body, publication) => readIndexOrigins(body, branch, publication, keys),
    ),
  ]);
  return { secdb, index };
}

function sourceData<T>(source: ReadSource<T>): T[] {
  return "data" in source ? [source.data] : [];
}

/** Assess each source separately so valid evidence stays visible during a partial outage. */
export async function readAlpineBranch(branch: string, fetcher: ApkFetcher, keys?: ApkIndexKeys) {
  const repositories = await Promise.all(
    REPOSITORIES.map((repo) => readRepository(branch, repo, fetcher, keys)),
  );
  const sources = repositories.flatMap(({ secdb, index }) => [secdb.evidence, index.evidence]);
  return {
    sources,
    failures: sources.flatMap((source) => ("reason" in source ? [source.reason] : [])),
    checked: sources.filter((source) => !("reason" in source)).map(sourceLabel),
    originsComplete: repositories.every(({ index }) => "data" in index),
    secfixes: mergeSecdb(repositories.flatMap(({ secdb }) => sourceData(secdb))),
    origins: mergeApkIndexOrigins(repositories.flatMap(({ index }) => sourceData(index))),
  };
}

export async function readNewestStableBranch(fetcher: ApkFetcher): Promise<ReadSource<string>> {
  return readSource(fetcher, { kind: "branch-list", url: `${SECDB}/` }, (bytes) => {
    if (bytes.length > ALPINE_SOURCE_MAX_BYTES) throw new Error("secdb index: response too large");
    if (!isUtf8(bytes)) throw new Error("secdb index: invalid UTF-8");
    const branch = newestStableBranch(bytes.toString("utf8"));
    if (!branch) throw new Error("secdb index lists no stable branch");
    return branch;
  });
}

export function aggregateAlpineStatus(
  sources: readonly AlpineSourceEvidence[],
  incomplete: boolean,
  hasFindings: boolean,
): ScannerEvidenceStatus {
  if (!incomplete) return hasFindings ? "complete" : "complete-empty";
  const first = sources[0];
  if (first && "reason" in first && sources.every((source) => source.status === first.status))
    return first.status;
  return "partial";
}
