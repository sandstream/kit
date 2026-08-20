/**
 * What the latest version of a tool is — per installer, cached, and honest when it cannot say.
 *
 * `latest` in `[tools]` was compared against nothing: `check-tools.ts` returned `true` for it
 * before looking at anything, so `✓ vercel 53.1.1 (need latest)` was printed while the registry
 * had 59.1.4 — six majors on (#500). The fix needs a source of truth per installer, because
 * "latest" is a different question for brew, mise and npm.
 *
 * Three hard rules, from kit's own no-false-green stance:
 *
 * 1. **A lookup that could not run is `unavailable`, never "current".** Offline, air-gapped, a
 *    missing installer, a timeout — all report a reason and leave the verdict unknown. The old
 *    behaviour (assume fine) is exactly the false green this closes.
 * 2. **An installer kit cannot query is `unsupported`, and says which.** `/usr/bin/git` has no
 *    registry to ask; pretending it is current would be the same lie in a smaller font.
 * 3. **Never let the check become a network dependency.** Results are cached with a TTL
 *    (default 24h, `KIT_TOOL_LATEST_TTL_H`), and air-gap posture skips the lookups entirely, so
 *    a normal `kit check` makes no outbound call once warm.
 *
 * Everything is injected — the runner, the clock, the cache — so the tests never touch a
 * registry or the real `~/.kit`.
 */

import type { ToolSource } from "./tool-provenance.js";

export type LatestOutcome =
  /** The installer answered: this is the newest version it would install. */
  | { status: "known"; version: string; via: string; cached: boolean }
  /** kit has no way to ask this installer. Not a finding, and not a pass either. */
  | { status: "unsupported"; reason: string }
  /** kit could not ask right now (offline, air-gap, installer missing, timeout). */
  | { status: "unavailable"; reason: string };

export interface LatestCacheEntry {
  version: string;
  /** Epoch ms when the answer was recorded. */
  at: number;
  via: string;
}

export type LatestCache = Record<string, LatestCacheEntry>;

export interface LatestDeps {
  /** Run an installer command. Must never throw; `ok:false` means "could not ask". */
  run: (cmd: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>;
  now: () => number;
  readCache: () => Promise<LatestCache>;
  writeCache: (cache: LatestCache) => Promise<void>;
  /** Air-gap / offline posture: skip every lookup, report why. */
  offline: boolean;
  /**
   * Read the cache, never fill it. `kit check` runs on this: requirement 6 of #500 is that the
   * gate must not become slow or network-dependent, and a gate that quietly shells out to four
   * registries is exactly that. Drift still surfaces the moment something else warmed the cache
   * (`kit tools list --latest`), and until then the row says so instead of passing.
   */
  cacheOnly?: boolean;
  /** Cache lifetime in hours. */
  ttlHours?: number;
}

const DEFAULT_TTL_HOURS = 24;

/** Cache key: the answer depends on the installer as much as on the name. */
export function latestCacheKey(tool: string, source: ToolSource): string {
  return `${source}:${tool}`;
}

/** First version-looking token, so `mise latest node` / `brew info` chatter is tolerated. */
export function firstVersion(text: string): string | null {
  const m = text.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-.][A-Za-z0-9.]+)?)\b/);
  return m ? m[1] : null;
}

/**
 * How to ask each installer. Returning null means "kit has no query for this source" —
 * `system`, `cargo`, `go`, `unknown`: the binary exists, nothing kit can compare it to.
 *
 * `kit-shim` deliberately has no query: the shim delegates, so asking about the shim would
 * answer about the wrong thing. The caller resolves what it wraps first, or gets `unsupported`.
 */
function queryFor(
  tool: string,
  source: ToolSource,
): { cmd: string; args: string[]; via: string } | null {
  switch (source) {
    case "npm-global":
      return { cmd: "npm", args: ["view", tool, "version"], via: "npm" };
    case "mise":
      return { cmd: "mise", args: ["latest", tool], via: "mise" };
    case "brew":
      return { cmd: "brew", args: ["info", "--json=v2", "--formula", tool], via: "brew" };
    case "pipx":
      return { cmd: "pip", args: ["index", "versions", tool], via: "pip" };
    default:
      return null;
  }
}

/** Pull the stable version out of `brew info --json=v2` without pulling in a JSON schema. */
export function parseBrewInfoVersion(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as {
      formulae?: Array<{ versions?: { stable?: string | null } }>;
      casks?: Array<{ version?: string | null }>;
    };
    const stable = parsed.formulae?.[0]?.versions?.stable ?? parsed.casks?.[0]?.version;
    return stable ?? null;
  } catch {
    return null;
  }
}

/**
 * The newest version `source` would install for `tool`.
 *
 * Cache-first, then one command, then written back. A failed lookup is NOT cached: a flaky
 * network would otherwise pin "unavailable" for a day, which turns a transient into a policy.
 */
export async function latestVersion(
  tool: string,
  source: ToolSource,
  deps: LatestDeps,
): Promise<LatestOutcome> {
  const query = queryFor(tool, source);
  if (!query) {
    return {
      status: "unsupported",
      reason:
        source === "kit-shim"
          ? "kit PATH shim — resolve what it delegates to before asking for a latest version"
          : `no registry kit can query for a ${source} install`,
    };
  }

  const key = latestCacheKey(tool, source);
  const ttlMs = (deps.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000;
  const cache = await deps.readCache();
  const hit = cache[key];
  if (hit && deps.now() - hit.at < ttlMs) {
    return { status: "known", version: hit.version, via: hit.via, cached: true };
  }

  if (deps.cacheOnly) {
    return {
      status: "unavailable",
      reason: hit
        ? `cached answer is older than the TTL (${hit.version}) — run \`kit tools list --latest\` to refresh`
        : "not looked up yet — run `kit tools list --latest` (this gate does not call registries)",
    };
  }

  if (deps.offline) {
    return {
      status: "unavailable",
      reason: hit
        ? `air-gap/offline: cached answer from this machine is older than the TTL (${hit.version})`
        : "air-gap/offline: no registry lookup made, and nothing cached",
    };
  }

  const res = await deps.run(query.cmd, query.args);
  if (!res.ok) {
    return {
      status: "unavailable",
      reason: `\`${query.cmd} ${query.args.join(" ")}\` did not answer (installer missing, offline, or timed out)`,
    };
  }

  const version =
    query.via === "brew"
      ? (parseBrewInfoVersion(res.stdout) ?? firstVersion(res.stdout))
      : firstVersion(res.stdout);
  if (!version) {
    return {
      status: "unavailable",
      reason: `\`${query.cmd} ${query.args.join(" ")}\` answered, but no version could be read from it`,
    };
  }

  cache[key] = { version, at: deps.now(), via: query.via };
  await deps.writeCache(cache);
  return { status: "known", version, via: query.via, cached: false };
}

export type DriftVerdict =
  | { drift: "current" }
  | { drift: "behind"; installed: string; latest: string }
  /** Installed is NEWER than what the installer offers — a warning, not an error. */
  | { drift: "ahead"; installed: string; latest: string }
  | { drift: "unknown"; reason: string };

/**
 * Compare an installed version to a latest outcome.
 *
 * Numeric-segment comparison, not string compare: `53.1.1` vs `59.1.4` is the case that
 * mattered, and `9.0.0` vs `10.0.0` is the one a naive compare gets backwards. Anything
 * unparseable is `unknown` with a reason — never silently "current".
 */
export function compareVersions(installed: string, latest: string): -1 | 0 | 1 | null {
  const parse = (v: string): number[] | null => {
    const core = v.trim().replace(/^v/, "").split(/[-+]/)[0];
    if (!/^\d+(\.\d+)*$/.test(core)) return null;
    return core.split(".").map((n) => Number.parseInt(n, 10));
  };
  const a = parse(installed);
  const b = parse(latest);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function judgeDrift(installed: string | null, latest: LatestOutcome): DriftVerdict {
  if (installed === null) return { drift: "unknown", reason: "tool not installed" };
  if (latest.status !== "known") return { drift: "unknown", reason: latest.reason };
  const cmp = compareVersions(installed, latest.version);
  if (cmp === null) {
    return {
      drift: "unknown",
      reason: `cannot compare installed ${installed} with latest ${latest.version}`,
    };
  }
  if (cmp < 0) return { drift: "behind", installed, latest: latest.version };
  if (cmp > 0) return { drift: "ahead", installed, latest: latest.version };
  return { drift: "current" };
}
