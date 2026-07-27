/**
 * Bumblebee release notice — "your pinned scanner is behind upstream".
 *
 * `src/bumblebee.ts` pins BUMBLEBEE_VERSION + TARBALL_CHECKSUMS deliberately: an
 * executable whose checksum we cannot verify in advance is exactly the supply-chain
 * attack kit exists to catch, so the binary is NEVER auto-updated. But the
 * threat_intel/ exposure catalogs ship INSIDE that pinned tarball, which couples data
 * with a days-scale half-life to a binary with a months-scale one. That coupling is
 * why the catalogs go stale, and kit already reports the age honestly (advisory, not
 * gated — see check-security.ts).
 *
 * What was missing is the other half of the sentence: kit knew the catalogs were old
 * but never whether a newer release exists to bump TO. This module closes that, as a
 * NOTICE only — it tells you a bump is available and leaves the bump a deliberate,
 * reviewed commit where VERSION and CHECKSUMS move together.
 *
 * Deliberately NOT part of any verdict. Whether upstream has cut a release depends on
 * the network and someone else's schedule, so letting it touch pass/fail would make
 * `kit ci --strict` non-deterministic for an unchanged repo — the same reasoning that
 * keeps catalog AGE out of the verdict.
 *
 * Network posture mirrors the kit self-update check exactly: one shared suppression
 * decision (air-gap / CI / opt-out), a 3s timeout, a cached result, and every failure
 * path returning null. A notice must never slow down, break, or leak out of a run.
 *
 * MEASURED (2026-07-27, upstream v0.1.1 → v0.1.2): a bump moved the catalogs from 6 to
 * 11 files and the newest authoring date from 2026-05-18 to 2026-06-18 (65 → 38 days),
 * adding glassworm, trapdoor-crypto-stealer, mastra-2026-06-17, laravel-lang-2026-05-23
 * and mini-shai-hulud-redhat-cloud-services. It also widened inventory COVERAGE: an
 * `agent-skill` ecosystem (skills.sh / vercel-labs lock files), `homebrew` receipts, and
 * `~/.claude.json` MCP parsing.
 *
 * Method note worth keeping, because getting it wrong once cost a wrong conclusion: the
 * six pre-existing catalogs are byte-identical across those tags, so comparing only the
 * filenames you already know looks like "nothing changed". `raw.githubusercontent.com`
 * cannot list a directory — the ADDED files are invisible that way. Compare the actual
 * release tarball, not a guessed file list.
 *
 * So the notice reports "a newer release exists" and leaves whether it ships fresher
 * catalogs to be checked rather than assumed — sometimes it does, sometimes the age is
 * upstream's own. Note also that a *tag* is not a *release*: this reads the releases API
 * and skips drafts/prereleases, so a tagged-but-unreleased version produces silence.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isNewer, isValidVersion, isAirGapPosture } from "./update-check.js";

/** GitHub releases API for the upstream repo the pinned tarballs come from. */
const RELEASES_URL = "https://api.github.com/repos/perplexityai/bumblebee/releases";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = join(homedir(), ".kit");
const CACHE_FILE = join(CACHE_DIR, "last-bumblebee-release-check.json");
const FETCH_TIMEOUT_MS = 3_000;

export interface BumblebeeUpdateInfo {
  /** The version pinned in src/bumblebee.ts. */
  pinned: string;
  /** Newest stable upstream release. */
  latest: string;
}

interface ReleaseCheckCache {
  checkedAt: number;
  latestVersion: string;
}

/**
 * Normalize a GitHub release tag to a bare version (`v0.2.0` → `0.2.0`).
 * Returns null for anything that is not a plain version — a tag we cannot parse is
 * never compared, so a weird upstream tagging scheme produces no notice rather than
 * a wrong one.
 */
export function parseReleaseTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const bare = tag.trim().replace(/^v/i, "");
  return isValidVersion(bare) ? bare : null;
}

/** One entry of the releases payload, as much of it as we care about. */
interface ReleaseEntry {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/**
 * Highest stable version in a GitHub releases payload. Drafts and prereleases are
 * skipped (kit pins releases people can actually download), and the maximum is taken
 * by version order rather than trusting the array order.
 */
export function pickLatestStableRelease(payload: unknown): string | null {
  const list: unknown[] = Array.isArray(payload) ? payload : [payload];
  let best: string | null = null;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as ReleaseEntry;
    if (r.draft === true || r.prerelease === true) continue;
    const v = parseReleaseTag(r.tag_name);
    if (v && (best === null || isNewer(v, best))) best = v;
  }
  return best;
}

/**
 * Pure comparison: an update to report, or null when the pin is current (or the
 * comparison is not decidable). `isNewer` fails closed on malformed input, so garbage
 * in the cache or the payload silently yields no notice.
 */
export function bumblebeeUpdateFrom(pinned: string, latest: string): BumblebeeUpdateInfo | null {
  return isNewer(latest, pinned) ? { pinned, latest } : null;
}

/** True when kit must not make the outbound release check. */
async function checkSuppressed(): Promise<boolean> {
  return (
    process.env.KIT_NO_UPDATE_CHECK === "1" ||
    process.env.CI === "true" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.GITLAB_CI === "true" ||
    (await isAirGapPosture())
  );
}

/**
 * Check upstream for a newer bumblebee release, honoring the cache and the shared
 * suppression posture. Never throws and never rejects: every failure — suppressed,
 * offline, timeout, rate-limited, malformed JSON — returns null.
 */
export async function checkForBumblebeeUpdate(
  pinnedVersion: string,
): Promise<BumblebeeUpdateInfo | null> {
  try {
    if (await checkSuppressed()) return null;

    let cache: ReleaseCheckCache | null = null;
    try {
      cache = JSON.parse(await readFile(CACHE_FILE, "utf8")) as ReleaseCheckCache;
    } catch {
      /* no cache yet */
    }

    const now = Date.now();
    if (cache && now - cache.checkedAt < CHECK_INTERVAL_MS) {
      return bumblebeeUpdateFrom(pinnedVersion, cache.latestVersion);
    }

    const resp = await fetch(`${RELEASES_URL}?per_page=10`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!resp.ok) return null;

    const latest = pickLatestStableRelease(await resp.json());
    // Only a version we successfully parsed is cached, so the cache can never hold a
    // value that would later be compared as garbage.
    if (!latest) return null;

    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(
        CACHE_FILE,
        JSON.stringify({ checkedAt: now, latestVersion: latest }),
        "utf8",
      );
    } catch {
      /* cache write failure is non-fatal */
    }

    return bumblebeeUpdateFrom(pinnedVersion, latest);
  } catch {
    return null;
  }
}

/**
 * Cached-only, synchronous read for paths that must not touch the network — notably
 * the security check, which stays offline so its output does not depend on whether a
 * GitHub request happened to succeed. Returns null when there is no usable cache.
 */
export function readCachedBumblebeeUpdateSync(pinnedVersion: string): BumblebeeUpdateInfo | null {
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as ReleaseCheckCache;
    if (!cache || typeof cache.latestVersion !== "string") return null;
    return bumblebeeUpdateFrom(pinnedVersion, cache.latestVersion);
  } catch {
    return null;
  }
}

/** One-line notice text. Kept pure so the wording is testable without any I/O. */
export function formatBumblebeeNotice(info: BumblebeeUpdateInfo): string {
  return `bumblebee ${info.pinned} pinned · ${info.latest} available upstream — bump BUMBLEBEE_VERSION + TARBALL_CHECKSUMS together in src/bumblebee.ts`;
}
