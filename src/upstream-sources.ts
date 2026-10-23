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
const TAGS_PER_REPO = 100;
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
  githubReleases(repo: string, perPage?: number): Promise<ReleaseInfo[]>;
  /** Tag names, for projects that publish no GitHub releases (cpython). */
  githubTags(repo: string): Promise<string[]>;
  /** One file of a repository as raw text (a release schedule). */
  githubFile(repo: string, path: string): Promise<string>;
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

/**
 * Remove terminal control characters (ESC, BEL, C1 controls) from text that came from the network,
 * so a release note cannot move the cursor, clear the screen or set the window title. Line breaks
 * and tabs stay when `keepLayout` is true (release bodies); single-line fields lose them too.
 */
export function stripControl(value: string, keepLayout = false): string {
  const pattern = keepLayout
    ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
    : /[\u0000-\u001f\u007f-\u009f]/g;
  return value.replace(pattern, "");
}

function text(value: unknown, keepLayout = false): string {
  return typeof value === "string" ? stripControl(value, keepLayout) : "";
}

export function parseReleases(payload: unknown): ReleaseInfo[] {
  if (!Array.isArray(payload)) return [];
  const out: ReleaseInfo[] = [];
  for (const raw of payload) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (r.draft === true || typeof r.tag_name !== "string") continue;
    const bare = stripControl(r.tag_name).trim().replace(/^v/i, "");
    out.push({
      tag: stripControl(r.tag_name),
      version: isValidVersion(bare) ? bare : null,
      name: text(r.name),
      body: text(r.body, true).slice(0, MAX_BODY_CHARS),
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
    const url = `${registry}/${name.replaceAll("/", "%2F")}`;
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
): (repo: string, perPage?: number) => Promise<ReleaseInfo[]> {
  return async (repo, perPage = RELEASES_PER_REPO) => {
    const out = await run("gh", ["api", `repos/${repo}/releases?per_page=${perPage}`]);
    let payload: unknown;
    try {
      payload = JSON.parse(out);
    } catch {
      throw new Error(`gh gave output that is not JSON for ${repo}`);
    }
    return parseReleases(payload);
  };
}

export function createGhTagFetcher(run: GhRun = runGh): (repo: string) => Promise<string[]> {
  return async (repo) => {
    const out = await run("gh", ["api", `repos/${repo}/tags?per_page=${TAGS_PER_REPO}`]);
    let payload: unknown;
    try {
      payload = JSON.parse(out);
    } catch {
      throw new Error(`gh gave output that is not JSON for ${repo}`);
    }
    if (!Array.isArray(payload)) return [];
    return payload.flatMap((t: unknown) => {
      const name = (t as { name?: unknown } | null)?.name;
      return typeof name === "string" ? [stripControl(name)] : [];
    });
  };
}

const MAX_FILE_CHARS = 1_000_000;
const FILE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** One file of a repository, raw. The path is validated: it cannot leave the repository or look like an option. */
export function createGhFileFetcher(
  run: GhRun = runGh,
): (repo: string, path: string) => Promise<string> {
  return async (repo, path) => {
    if (!FILE_PATH.test(path) || path.split("/").includes("..")) {
      throw new Error(`not a repository file path: ${stripControl(path).slice(0, 60)}`);
    }
    const out = await run("gh", [
      "api",
      "-H",
      "Accept: application/vnd.github.raw+json",
      `repos/${repo}/contents/${path}`,
    ]);
    if (out.length > MAX_FILE_CHARS) throw new Error(`${path} is too large to read`);
    return out;
  };
}

export function createDefaultFetcher(): UpstreamFetcher {
  return {
    npmLatest: createNpmLatestFetcher(),
    githubReleases: createGhReleaseFetcher(),
    githubTags: createGhTagFetcher(),
    githubFile: createGhFileFetcher(),
  };
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
  tags: SourceResult<{ tags: string[] }>[];
  files: SourceResult<{ text: string }>[];
}

export interface LookupDeps {
  fetcher?: UpstreamFetcher;
  posture?: UpstreamPosture;
  cacheDir?: string;
  ttlMs?: number;
  now?: () => number;
  /** Read the cache only: no fetch, no write, no network posture check. A miss is reported, never filled. */
  cacheOnly?: boolean;
}

interface CacheFile {
  version: 1;
  entries: Record<
    string,
    { at: number; latest?: string; releases?: ReleaseInfo[]; tags?: string[]; text?: string }
  >;
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
  return stripControl(err instanceof Error ? err.message : String(err));
}

export interface UpstreamService {
  npm: readonly string[];
  github: readonly string[];
  /** Repos whose tag names are read because they publish no GitHub releases. */
  githubTags?: readonly string[];
  /** Repository files to read as text (a release schedule), as `{ repo, path }`. */
  githubFiles?: readonly { repo: string; path: string }[];
  /** How many releases to read per repo (default 10). A wider window reaches an older release line. */
  releaseWindow?: number;
}

type Entry = Omit<CacheFile["entries"][string], "at">;

export async function lookupUpstream(
  service: UpstreamService,
  deps: LookupDeps = {},
): Promise<UpstreamLookup> {
  // A cache-only read opens no socket, so the air-gap and read-only postures do not apply to it.
  const posture = deps.cacheOnly ? { allowed: true } : (deps.posture ?? (await upstreamPosture()));
  if (!posture.allowed) {
    return {
      status: "skipped",
      reason: (posture as UpstreamPosture).reason,
      npm: [],
      github: [],
      tags: [],
      files: [],
    };
  }
  const fetcher = deps.fetcher ?? createDefaultFetcher();
  const dir = deps.cacheDir ?? join(homedir(), ".kit");
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = (deps.now ?? Date.now)();
  const cache = await readCache(dir);
  let dirty = false;

  /** One source: a fresh cache hit, else a fetch. A failure is reported and never cached. */
  const source = async <T>(
    key: string,
    name: string,
    pick: (e: Entry) => T | undefined,
    fetchIt: () => Promise<T>,
    store: (value: T) => Entry,
  ): Promise<SourceResult<{ value: T }>> => {
    const hit = cache.entries[key];
    const cached = hit && now - hit.at >= 0 && now - hit.at < ttl ? pick(hit) : undefined;
    if (cached !== undefined) return { name, ok: true, value: cached };
    if (deps.cacheOnly) {
      return {
        name,
        ok: false,
        error: "not in the cache or older than its limit (run kit upstream check)",
      };
    }
    try {
      const value = await fetchIt();
      cache.entries[key] = { at: now, ...store(value) };
      dirty = true;
      return { name, ok: true, value };
    } catch (err) {
      return { name, ok: false, error: message(err) };
    }
  };

  const window = service.releaseWindow;
  const npm = await Promise.all(
    service.npm.map(async (name): Promise<SourceResult<{ latest: string }>> => {
      const r = await source(
        `npm:${name}`,
        name,
        (e) => e.latest,
        () => fetcher.npmLatest(name),
        (latest) => ({ latest }),
      );
      return r.ok ? { name, ok: true, latest: r.value } : r;
    }),
  );
  const github = await Promise.all(
    service.github.map(async (name): Promise<SourceResult<{ releases: ReleaseInfo[] }>> => {
      const key = window === undefined ? `gh:${name}` : `gh:${name}:${window}`;
      const r = await source(
        key,
        name,
        (e) => e.releases,
        () => fetcher.githubReleases(name, window),
        (releases) => ({ releases }),
      );
      return r.ok ? { name, ok: true, releases: r.value } : r;
    }),
  );
  const tags = await Promise.all(
    (service.githubTags ?? []).map(async (name): Promise<SourceResult<{ tags: string[] }>> => {
      const r = await source(
        `tags:${name}`,
        name,
        (e) => e.tags,
        () => fetcher.githubTags(name),
        (list) => ({ tags: list }),
      );
      return r.ok ? { name, ok: true, tags: r.value } : r;
    }),
  );

  const files = await Promise.all(
    (service.githubFiles ?? []).map(
      async ({ repo, path }): Promise<SourceResult<{ text: string }>> => {
        const name = `${repo}:${path}`;
        const r = await source(
          `file:${name}`,
          name,
          (e) => e.text,
          () => fetcher.githubFile(repo, path),
          (text) => ({ text }),
        );
        return r.ok ? { name, ok: true, text: r.value } : r;
      },
    ),
  );

  if (dirty) await writeCache(dir, cache);
  const anyOk = [...npm, ...github, ...tags, ...files].some((r) => r.ok);
  return { status: anyOk ? "ok" : "unknown", npm, github, tags, files };
}
