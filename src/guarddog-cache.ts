/**
 * GuardDog verdict cache (#205).
 *
 * A guarddog verify run costs ~25s per package (tarball fetch + per-package
 * semgrep), so it can never fit the local check budget when re-scanning an
 * unchanged dependency set. Cache the CLEAN verdict keyed by a hash of the
 * direct-deps map (name → version): any change to any direct dep misses the
 * cache and forces a real scan.
 *
 * Honesty rules:
 *   - only a COMPLETE clean scan is cached — fails and incomplete/UNVERIFIED
 *     results are never cached, so they re-run every time
 *   - a cache hit says so in the detail (verdict date), it never pretends to
 *     have just scanned
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface GuardDogCacheEntry {
  /** Hash of the direct-deps map this verdict covers. */
  depsHash: string;
  /** ISO timestamp of the completed clean scan. */
  scannedAt: string;
  /** Number of packages the clean scan covered. */
  packages: number;
}

export function guardDogCachePath(): string {
  return process.env.KIT_GUARDDOG_CACHE ?? join(homedir(), ".kit", "guarddog-cache.json");
}

/** Stable hash of the direct-deps map (deps + devDeps, name-sorted). */
export function depsHashFor(manifestRaw: string): string | null {
  try {
    const pkg = JSON.parse(manifestRaw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const canonical = Object.keys(all)
      .sort()
      .map((k) => `${k}@${all[k]}`)
      .join("\n");
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return null; // unparseable manifest — no caching, force a real scan
  }
}

export function loadGuardDogCache(path: string = guardDogCachePath()): GuardDogCacheEntry | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as GuardDogCacheEntry;
    if (typeof j.depsHash !== "string" || typeof j.scannedAt !== "string") return null;
    return j;
  } catch {
    return null;
  }
}

export function saveGuardDogCache(
  entry: GuardDogCacheEntry,
  path: string = guardDogCachePath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // cache write failure must never break the check — next run just re-scans
    console.warn(`kit: could not write guarddog cache at ${path} — next run re-scans`);
  }
}
