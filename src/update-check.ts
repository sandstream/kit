import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    // Suppression conditions
    if (
      process.env.KIT_NO_UPDATE_CHECK === "1" ||
      process.env.CI === "true" ||
      process.env.GITHUB_ACTIONS === "true" ||
      process.env.GITLAB_CI === "true"
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

/** Returns true if `latest` is strictly newer than `current` (semver comparison). */
function isNewer(latest: string, current: string): boolean {
  try {
    const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
    const [lMaj, lMin, lPatch] = parse(latest);
    const [cMaj, cMin, cPatch] = parse(current);
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
