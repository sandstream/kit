import { isUtf8 } from "node:buffer";
import { ALPINE_SOURCE_MAX_BYTES, type ApkFetcher } from "./check-apk-fetch.js";
import { mergeApkIndexOrigins, parseApkIndexOrigins } from "./alpine-index-origins.js";
import { apkIndexText } from "./alpine-index-archive.js";
import { mergeSecdb, readSecdbSource, type AlpineRepository } from "./alpine-secdb.js";
import { newestStableBranch } from "./dockerfile-apk-floors.js";
import { sanitizeDisplayText } from "./display-text.js";

const SECDB = "https://secdb.alpinelinux.org";
const CDN = "https://dl-cdn.alpinelinux.org/alpine";
const REPOSITORIES = ["main", "community"] as const;

type ReadSource<T> = { data: T; label: string } | { failure: string };

export function alpineSourceFailure(error: unknown, context: string): string {
  const detail = sanitizeDisplayText(error instanceof Error ? error.message : String(error)).slice(
    0,
    240,
  );
  return `${detail || "source unavailable"} (${context})`;
}

async function readSource<T>(
  fetcher: ApkFetcher,
  url: string,
  label: string,
  parse: (body: Buffer) => T,
): Promise<ReadSource<T>> {
  try {
    return { data: parse(await fetcher(url)), label };
  } catch (error) {
    return { failure: alpineSourceFailure(error, label) };
  }
}

async function readRepository(branch: string, repository: AlpineRepository, fetcher: ApkFetcher) {
  const root = `${branch}/${repository}`;
  const [secdb, index] = await Promise.all([
    readSource(fetcher, `${SECDB}/${root}.json`, `${branch} ${repository} secdb`, (body) =>
      readSecdbSource(body, { branch, repository }, ALPINE_SOURCE_MAX_BYTES),
    ),
    readSource(
      fetcher,
      `${CDN}/${root}/x86_64/APKINDEX.tar.gz`,
      `${branch} ${repository} APKINDEX (x86_64)`,
      (body) => parseApkIndexOrigins(apkIndexText(body)),
    ),
  ]);
  return { secdb, index };
}

function sourceData<T>(source: ReadSource<T>): T[] {
  return "data" in source ? [source.data] : [];
}

/** Assess each source separately so valid evidence stays visible during a partial outage. */
export async function readAlpineBranch(branch: string, fetcher: ApkFetcher) {
  const repositories = await Promise.all(
    REPOSITORIES.map((repo) => readRepository(branch, repo, fetcher)),
  );
  const sources = repositories.flatMap(({ secdb, index }) => [secdb, index]);
  return {
    failures: sources.flatMap((source) => ("failure" in source ? [source.failure] : [])),
    checked: sources.flatMap((source) => ("label" in source ? [source.label] : [])),
    originsComplete: repositories.every(({ index }) => "data" in index),
    secfixes: mergeSecdb(repositories.flatMap(({ secdb }) => sourceData(secdb))),
    origins: mergeApkIndexOrigins(repositories.flatMap(({ index }) => sourceData(index))),
  };
}

export async function readNewestStableBranch(fetcher: ApkFetcher): Promise<string> {
  const bytes = await fetcher(`${SECDB}/`);
  if (bytes.length > ALPINE_SOURCE_MAX_BYTES) throw new Error("secdb index: response too large");
  if (!isUtf8(bytes)) throw new Error("secdb index: invalid UTF-8");
  const branch = newestStableBranch(bytes.toString("utf8"));
  if (!branch) throw new Error("secdb index lists no stable branch");
  return branch;
}
