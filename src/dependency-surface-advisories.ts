/**
 * Known advisories per direct dependency, so the heavy source of them is visible.
 *
 * The one fact this asks the network for is the list of advisories OSV holds for each package and
 * version in the lockfile. Everything else (the closure of a direct dependency, the counts) is
 * computed here from the graph. Nothing is sent but package names and versions.
 *
 * The answers are cached for 24 hours under `~/.kit`. In an air gap nothing is fetched and only the
 * cache is read. A lookup that cannot finish says so; it never reads as "no advisories".
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DepGraph } from "./dependency-surface.js";

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";

const BATCH = 1000;
const TTL_MS = 24 * 3_600_000;
const MAX_CACHE_ENTRIES = 20_000;
const MAX_IDS_PER_PACKAGE = 200;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface PackageRef {
  name: string;
  version: string;
}

export interface AdvisoryDeps {
  /** POST a JSON body and return the response body, or throw. */
  post: (url: string, body: string) => Promise<string>;
  now: () => number;
  readCache: () => string | null;
  writeCache: (raw: string) => void;
  /** Air gap: no request at all. */
  offline: boolean;
}

export interface AdvisoryResult {
  /** `name@version` to advisory ids. A package with none is absent. */
  found: Map<string, string[]>;
  /** False when some package could not be looked up. Then `found` may be missing advisories. */
  checked: boolean;
  note?: string;
}

interface CacheEntry {
  ids: string[];
  fetchedAt: string;
}

interface CacheFile {
  v: 1;
  entries: Record<string, CacheEntry>;
}

const keyOf = (p: PackageRef): string => `${p.name}@${p.version}`;

function cleanIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((v): v is string => typeof v === "string" && ID_RE.test(v));
  return [...new Set(ids)].slice(0, MAX_IDS_PER_PACKAGE);
}

/** Read the cache. Every entry is checked again: the file is only as trusted as the disk. */
function readCache(raw: string | null): CacheFile {
  const empty: CacheFile = { v: 1, entries: {} };
  if (raw === null) return empty;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof doc !== "object" || doc === null) return empty;
  const entries = (doc as { entries?: unknown }).entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return empty;
  const out: CacheFile = { v: 1, entries: {} };
  for (const [key, value] of Object.entries(entries).slice(0, MAX_CACHE_ENTRIES)) {
    const e = value as { ids?: unknown; fetchedAt?: unknown };
    if (typeof e?.fetchedAt !== "string" || Number.isNaN(Date.parse(e.fetchedAt))) continue;
    out.entries[key] = { ids: cleanIds(e.ids), fetchedAt: e.fetchedAt };
  }
  return out;
}

const fresh = (e: CacheEntry, now: number): boolean => {
  const age = now - Date.parse(e.fetchedAt);
  return age >= 0 && age < TTL_MS;
};

function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
}

/** One request. Returns the advisory ids per package in order, or null for a malformed answer. */
async function askBatch(batch: PackageRef[], deps: AdvisoryDeps): Promise<string[][] | null> {
  const body = JSON.stringify({
    queries: batch.map((p) => ({
      package: { name: p.name, ecosystem: "npm" },
      version: p.version,
    })),
  });
  const doc: unknown = JSON.parse(await deps.post(OSV_BATCH_URL, body));
  const results = (doc as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== batch.length) return null;
  return results.map((r) => {
    const vulns = (r as { vulns?: unknown } | null)?.vulns;
    return cleanIds(Array.isArray(vulns) ? vulns.map((v) => (v as { id?: unknown })?.id) : []);
  });
}

/** Advisories for the given packages: fresh cache, else OSV, else the stale cache with a note. */
export async function loadAdvisories(
  packages: PackageRef[],
  deps: AdvisoryDeps,
): Promise<AdvisoryResult> {
  const unique = [...new Map(packages.map((p) => [keyOf(p), p])).values()];
  const cache = readCache(deps.readCache());
  const now = deps.now();
  const found = new Map<string, string[]>();
  const collect = (key: string, ids: string[]): void => {
    if (ids.length > 0) found.set(key, ids);
  };
  const missing: PackageRef[] = [];
  for (const p of unique) {
    const hit = cache.entries[keyOf(p)];
    if (hit && fresh(hit, now)) collect(keyOf(p), hit.ids);
    else missing.push(p);
  }
  if (missing.length === 0) return { found, checked: true };

  const keepStale = (): void => {
    for (const p of missing) {
      const hit = cache.entries[keyOf(p)];
      if (hit) collect(keyOf(p), hit.ids);
    }
  };
  if (deps.offline) {
    keepStale();
    return {
      found,
      checked: false,
      note: `air gap: ${missing.length} package(s) have no cached advisory answer, and nothing is fetched`,
    };
  }
  let dirty = false;
  try {
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const answers = await askBatch(batch, deps);
      if (answers === null) throw new Error("OSV answered in a shape this check does not read");
      batch.forEach((p, n) => {
        collect(keyOf(p), answers[n]);
        cache.entries[keyOf(p)] = { ids: answers[n], fetchedAt: new Date(now).toISOString() };
      });
      dirty = true;
    }
  } catch (e) {
    keepStale();
    writeIfDirty(cache, dirty, deps);
    return { found, checked: false, note: `OSV lookup failed: ${reason(e)}` };
  }
  writeIfDirty(cache, dirty, deps);
  return { found, checked: true };
}

function writeIfDirty(cache: CacheFile, dirty: boolean, deps: AdvisoryDeps): void {
  if (!dirty) return;
  try {
    deps.writeCache(JSON.stringify(cache));
  } catch {
    // A cache that cannot be written only costs a request next run.
  }
}

export interface DirectAdvisories {
  name: string;
  dev: boolean;
  /** Distinct advisory ids in the dependency and everything it brings. */
  ids: string[];
}

/** For each direct dependency, the advisories in its closure (itself included). Clean ones are left out. */
export function advisoriesPerDirect(
  graph: DepGraph,
  found: ReadonlyMap<string, string[]>,
): DirectAdvisories[] {
  const rows: DirectAdvisories[] = [];
  for (const [name, start] of graph.direct) {
    const seen = new Set<string>();
    const stack = [start];
    const ids = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = graph.nodes.get(id);
      if (!node) continue;
      for (const a of found.get(`${node.name}@${node.version}`) ?? []) ids.add(a);
      stack.push(...node.deps);
    }
    if (ids.size > 0) {
      rows.push({ name, dev: graph.nodes.get(start)?.dev ?? false, ids: [...ids] });
    }
  }
  return rows.sort((a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name));
}

/** The real I/O: `fetch` with a timeout and a size cap, and the cache file under ~/.kit. */
export function defaultAdvisoryDeps(offline: boolean): AdvisoryDeps {
  const path = process.env.KIT_ADVISORY_CACHE ?? join(homedir(), ".kit", "osv-advisories.json");
  return {
    offline,
    now: () => Date.now(),
    post: async (url, body) => {
      const res = await fetch(url, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(20_000),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "sandstream-kit",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > 32 * 1024 * 1024) throw new Error("response larger than 32 MiB");
      return text;
    },
    readCache: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeCache: (raw) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, raw, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}
