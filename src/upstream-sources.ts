/**
 * Version sources for `kit upstream`: the latest npm version and the GitHub releases of a service.
 * Both sit behind an injectable `UpstreamFetcher`, so tests never open a socket. Air-gap and
 * read-only mode skip every fetch and say so. A failed fetch is `unknown`, never "current", and a
 * failure is never cached. Answers are cached under `~/.kit` for a short TTL.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isReadOnlyMode } from "./read-only-mode.js";
import { isAirGapPosture, isValidVersion } from "./update-check.js";

const execFileAsync = promisify(execFile);

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 5_000;
const GH_TIMEOUT_MS = 15_000;
const RELEASES_PER_REPO = 10;
const MAX_BODY_CHARS = 20_000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_FILE = "upstream-cache.json";

export interface ReleaseInfo {
  tag: string;
  /** The tag as a plain version, or null when the tag is not one (for example `nightly`). */
  version: string | null;
  name: string;
  body: string;
  url: string;
  prerelease: boolean;
  publishedAt: string;
}

export interface UpstreamFetcher {
  npmLatest(name: string): Promise<string>;
  githubReleases(repo: string): Promise<ReleaseInfo[]>;
}

export interface UpstreamPosture {
  allowed: boolean;
  reason?: "air gap" | "read-only";
}

/** Whether this run may touch the network: air gap and read-only mode say no. */
export async function upstreamPosture(): Promise<UpstreamPosture> {
  if (await isAirGapPosture()) return { allowed: false, reason: "air gap" };
  if (isReadOnlyMode()) return { allowed: false, reason: "read-only" };
  return { allowed: true };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseReleases(payload: unknown): ReleaseInfo[] {
  if (!Array.isArray(payload)) return [];
  const out: ReleaseInfo[] = [];
  for (const raw of payload) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (r.draft === true || typeof r.tag_name !== "string") continue;
    const bare = r.tag_name.trim().replace(/^v/i, "");
    out.push({
      tag: r.tag_name,
      version: isValidVersion(bare) ? bare : null,
      name: text(r.name),
      body: text(r.body).slice(0, MAX_BODY_CHARS),
      url: text(r.html_url),
      prerelease: r.prerelease === true,
      publishedAt: text(r.published_at),
    });
  }
  return out;
}

export interface NpmFetcherOptions {
  registry?: string;
  fetchFn?: typeof fetch;
}

export function createNpmLatestFetcher(
  options: NpmFetcherOptions = {},
): (name: string) => Promise<string> {
  const registry = (options.registry ?? process.env.KIT_NPM_REGISTRY ?? DEFAULT_REGISTRY).replace(
    /\/+$/,
    "",
  );
  const fetchFn = options.fetchFn ?? fetch;
  return async (name) => {
    const url = `${registry}/${name.replace("/", "%2F")}`;
    const res = await fetchFn(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${name}`);
    const doc = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
    const latest = doc["dist-tags"]?.latest;
    if (!isValidVersion(latest))
      throw new Error(`npm registry gave no usable latest tag for ${name}`);
    return latest;
  };
}

export type GhRun = (command: string, args: string[]) => Promise<string>;

const runGh: GhRun = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, {
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
};

export function createGhReleaseFetcher(
  run: GhRun = runGh,
): (repo: string) => Promise<ReleaseInfo[]> {
  return async (repo) => {
    const out = await run("gh", ["api", `repos/${repo}/releases?per_page=${RELEASES_PER_REPO}`]);
    let payload: unknown;
    try {
      payload = JSON.parse(out);
    } catch {
      throw new Error(`gh gave output that is not JSON for ${repo}`);
    }
    return parseReleases(payload);
  };
}

export function createDefaultFetcher(): UpstreamFetcher {
  const npmLatest = createNpmLatestFetcher();
  const githubReleases = createGhReleaseFetcher();
  return { npmLatest, githubReleases };
}

export type SourceResult<T> =
  | ({ name: string; ok: true } & T)
  | { name: string; ok: false; error: string };

export interface UpstreamLookup {
  status: "ok" | "skipped" | "unknown";
  /** Why the lookup was skipped (`air gap`, `read-only`). */
  reason?: string;
  npm: SourceResult<{ latest: string }>[];
  github: SourceResult<{ releases: ReleaseInfo[] }>[];
}

export interface LookupDeps {
  fetcher?: UpstreamFetcher;
  posture?: UpstreamPosture;
  cacheDir?: string;
  ttlMs?: number;
  now?: () => number;
}

interface CacheFile {
  version: 1;
  entries: Record<string, { at: number; latest?: string; releases?: ReleaseInfo[] }>;
}

async function readCache(dir: string): Promise<CacheFile> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, CACHE_FILE), "utf-8")) as CacheFile;
    if (parsed?.version === 1 && typeof parsed.entries === "object" && parsed.entries !== null)
      return parsed;
  } catch {
    // no cache, or a corrupt one: start empty
  }
  return { version: 1, entries: {} };
}

async function writeCache(dir: string, cache: CacheFile): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, CACHE_FILE), JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // a cache that cannot be written only costs a fetch next time
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function lookupUpstream(
  service: { npm: readonly string[]; github: readonly string[] },
  deps: LookupDeps = {},
): Promise<UpstreamLookup> {
  const posture = deps.posture ?? (await upstreamPosture());
  if (!posture.allowed) {
    return { status: "skipped", reason: posture.reason, npm: [], github: [] };
  }
  const fetcher = deps.fetcher ?? createDefaultFetcher();
  const dir = deps.cacheDir ?? join(homedir(), ".kit");
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = (deps.now ?? Date.now)();
  const cache = await readCache(dir);
  let dirty = false;

  const fresh = (key: string) => {
    const hit = cache.entries[key];
    return hit && now - hit.at >= 0 && now - hit.at < ttl ? hit : undefined;
  };

  const npm = await Promise.all(
    service.npm.map(async (name): Promise<SourceResult<{ latest: string }>> => {
      const hit = fresh(`npm:${name}`);
      if (hit?.latest) return { name, ok: true, latest: hit.latest };
      try {
        const latest = await fetcher.npmLatest(name);
        cache.entries[`npm:${name}`] = { at: now, latest };
        dirty = true;
        return { name, ok: true, latest };
      } catch (err) {
        return { name, ok: false, error: message(err) };
      }
    }),
  );
  const github = await Promise.all(
    service.github.map(async (name): Promise<SourceResult<{ releases: ReleaseInfo[] }>> => {
      const hit = fresh(`gh:${name}`);
      if (hit?.releases) return { name, ok: true, releases: hit.releases };
      try {
        const releases = await fetcher.githubReleases(name);
        cache.entries[`gh:${name}`] = { at: now, releases };
        dirty = true;
        return { name, ok: true, releases };
      } catch (err) {
        return { name, ok: false, error: message(err) };
      }
    }),
  );

  if (dirty) await writeCache(dir, cache);
  const anyOk = [...npm, ...github].some((r) => r.ok);
  return { status: anyOk ? "ok" : "unknown", npm, github };
}
