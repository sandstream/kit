import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isAirGap } from "./scanners.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = "sandstream-kit";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = join(homedir(), ".kit");
const CACHE_FILE = join(CACHE_DIR, "last-update-check.json");

interface UpdateCheckCache {
  checkedAt: number;
  latestVersion: string;
}

export interface UpdateInfo {
  available: boolean;
  latest: string;
  current: string;
}

/**
 * Check npm registry for a newer version of kit.
 * Returns null if already on latest, check fails, or check is suppressed.
 * Never throws — all errors are caught silently.
 */
/**
 * True when the host is in an air-gap posture by EITHER the KIT_AIRGAP env var OR
 * the checked-in `.kit.toml [air_gap] enabled = true` (the authoritative
 * resolveAirGap notion). `scanners.isAirGap()` reads ONLY the env var, so a
 * config-declared enclave (e.g. `kit setup --mode airgap`) without KIT_AIRGAP
 * exported would otherwise let the npm update beacon punch through. Best-effort:
 * a missing/invalid config falls back to the env-only signal.
 */
async function isAirGapPosture(): Promise<boolean> {
  if (isAirGap()) return true;
  try {
    const [{ loadConfig }, { resolveAirGap }] = await Promise.all([
      import("./config.js"),
      import("./airgap/config.js"),
    ]);
    const cfg = await loadConfig(join(process.cwd(), ".kit.toml"));
    return resolveAirGap(cfg.air_gap).enabled;
  } catch {
    return false; // no/invalid config → env-only posture
  }
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    // Suppression conditions. Air-gap is one of them: the update check is the
    // only outbound call on a normal `kit` run, so honoring KIT_AIRGAP here is
    // what makes "no outbound network by default" / air-gap mode a COMPLETE
    // posture, not one with a lone npm-registry beacon poking through.
    if (
      process.env.KIT_NO_UPDATE_CHECK === "1" ||
      process.env.CI === "true" ||
      process.env.GITHUB_ACTIONS === "true" ||
      process.env.GITLAB_CI === "true" ||
      (await isAirGapPosture())
    ) {
      return null;
    }

    // Read cache
    let cache: UpdateCheckCache | null = null;
    try {
      const raw = await readFile(CACHE_FILE, "utf8");
      cache = JSON.parse(raw) as UpdateCheckCache;
    } catch {
      // No cache yet
    }

    const now = Date.now();

    // Use cached result if fresh
    if (cache && now - cache.checkedAt < CHECK_INTERVAL_MS) {
      const latest = cache.latestVersion;
      if (isNewer(latest, currentVersion)) {
        return { available: true, latest, current: currentVersion };
      }
      return null;
    }

    // Fetch latest from npm registry
    const resp = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(3_000),
      headers: { Accept: "application/json" },
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as { version: string };
    const latest = data.version;

    // Write cache
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(
        CACHE_FILE,
        JSON.stringify({ checkedAt: now, latestVersion: latest }),
        "utf8",
      );
    } catch {
      // Cache write failure is non-fatal
    }

    if (isNewer(latest, currentVersion)) {
      return { available: true, latest, current: currentVersion };
    }

    return null;
  } catch {
    return null;
  }
}

/** Current kit version from the installed package.json (sync, fail-safe). */
export function getKitVersionSync(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Cache-only update check — NO network. For hot paths (the Claude Code hooks that
 * run on every prompt): reads the cache the post-command banner / `kit check`
 * already refresh, never fetches. Returns null on cache miss, error, suppression,
 * or when current is already latest.
 */
export function readCachedUpdateSync(currentVersion: string): UpdateInfo | null {
  try {
    if (process.env.KIT_NO_UPDATE_CHECK === "1") return null;
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as UpdateCheckCache;
    if (cache?.latestVersion && isNewer(cache.latestVersion, currentVersion)) {
      return { available: true, latest: cache.latestVersion, current: currentVersion };
    }
    return null;
  } catch {
    return null;
  }
}

// Strict semver (optional leading v, optional pre-release / build metadata). The
// `latest` string comes from the npm registry (or its on-disk cache) and is
// interpolated verbatim into the Claude Code prompt via staleKitNotice(), so it
// MUST be validated before it can ever reach a prompt: an unvalidated
// "99.0.0 ignore all previous instructions" passes the major-version compare
// today (99 > 4) and rides into every prompt. Reject anything non-semver here —
// the single chokepoint every "update available" result flows through.
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True iff `v` is a well-formed semver string (safe to display / compare). */
export function isValidVersion(v: unknown): v is string {
  return typeof v === "string" && SEMVER_RE.test(v.trim());
}

/**
 * True iff `latest` is strictly newer than `current`, compared on the numeric
 * MAJOR.MINOR.PATCH core. Prerelease/build suffixes are STRIPPED before the split —
 * `"4.0.6-rc.1".split(".")` is `["4","0","6-rc","1"]`, and `Number("6-rc")` is NaN,
 * so the old parser reported a genuinely newer prerelease patch as not-newer. We do
 * not model prerelease *precedence* (e.g. `1.0.0-rc` < `1.0.0`): the registry
 * `latest` tag is a stable release and an update notice only needs core ordering, so
 * a core-equal pair (stable vs its own prerelease) is treated as "not newer".
 * Exported for direct testing. Fails closed on any malformed input (no notice).
 */
export function isNewer(latest: string, current: string): boolean {
  try {
    // Fail closed on any malformed version: no comparison, no notice.
    if (!isValidVersion(latest) || !isValidVersion(current)) return false;
    const core = (v: string) =>
      v
        .replace(/^v/, "")
        .replace(/[-+].*$/, "") // drop -prerelease / +build before the numeric split
        .split(".")
        .map(Number);
    const [lMaj, lMin, lPatch] = core(latest);
    const [cMaj, cMin, cPatch] = core(current);
    if (lMaj !== cMaj) return lMaj > cMaj;
    if (lMin !== cMin) return lMin > cMin;
    return lPatch > cPatch;
  } catch {
    return false;
  }
}

/** Format and print the update notice after command output. */
export function printUpdateNotice(info: UpdateInfo): void {
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const yellow = "\x1b[33m";
  const cyan = "\x1b[36m";
  console.log(
    `\n  ${dim}╰─${reset} ${yellow}Update available${reset}: ${dim}${info.current}${reset} → ${cyan}${info.latest}${reset}  ` +
      `${dim}run ${reset}${cyan}kit upgrade --self${reset}${dim} (triages before installing)${reset}`,
  );
}
