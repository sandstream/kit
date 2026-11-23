/**
 * Whether the daily `kit watch` is still running.
 *
 * `kit watch` ranks open security PRs and Dependabot alerts once a day from a scheduler entry
 * (launchd, cron or a workflow) and caches the result in `.kit/watch.json`. When the scheduled run
 * stops (a moved node binary, a deleted plist, a workflow nobody re-enabled), nothing announced it:
 * only Claude Code's status line showed `sec-prs:stale`, with no age, and `kit check` had no row.
 * A Codex user, or a person reading `kit check`, never saw it (kit-research
 * `patching-what-you-build-vs-kit`: a Plex server whose automatic updates failed unnoticed).
 *
 * Rows:
 *   - the cache is fresh (younger than 48 hours): pass, with its age;
 *   - the cache is older: warn, with the age and the command that runs the watch now;
 *   - no cache, but a launchd entry or the `kit-watch` workflow exists for this project: warn,
 *     scheduled but never ran;
 *   - no cache and no entry kit can see: no row (the watch is opt-in). A cron entry cannot be seen:
 *     kit prints the line and never edits a crontab.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { readWatchCache, WATCH_STALE_MS, watchLaunchdLabel } from "./watch.js";

const NAME = "security watch freshness";
const HOUR = 3_600_000;

function age(ms: number): string {
  if (ms < 2 * HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} h`;
  return `${Math.floor(ms / (24 * HOUR))} days`;
}

/** Where a scheduler entry for this project's watch exists, as kit can see it. */
function scheduledAt(cwd: string, home: string): string | null {
  if (existsSync(resolve(cwd, ".github", "workflows", "kit-watch.yml"))) {
    return ".github/workflows/kit-watch.yml";
  }
  const plist = join(home, "Library", "LaunchAgents", `${watchLaunchdLabel(cwd)}.plist`);
  return existsSync(plist) ? `~/Library/LaunchAgents/${watchLaunchdLabel(cwd)}.plist` : null;
}

export function checkWatchFreshness(
  cwd: string,
  now: number = Date.now(),
  home: string = homedir(),
): SecurityCheckResult[] {
  const cache = readWatchCache(cwd);
  if (!cache) {
    const where = scheduledAt(cwd, home);
    if (!where) return [];
    return [
      {
        category: "exposure",
        name: NAME,
        status: "warn",
        severity: "medium",
        detail: `kit watch is scheduled (${where}) but has never written .kit/watch.json, so the scheduled run is not running`,
        suggestion:
          "run `kit watch run` once, then check why the scheduler entry does not start it",
      },
    ];
  }
  const elapsed = now - Date.parse(cache.at);
  if (!Number.isFinite(elapsed) || elapsed > WATCH_STALE_MS) {
    const when = Number.isFinite(elapsed)
      ? `${age(elapsed)} ago (${cache.at.slice(0, 10)})`
      : "at an unreadable time";
    return [
      {
        category: "exposure",
        name: NAME,
        status: "warn",
        severity: "medium",
        detail: `the last kit watch run was ${when}: the daily run has stopped, so new security PRs and Dependabot alerts are not being ranked`,
        suggestion:
          "run `kit watch run` now, then check the scheduler entry (crontab, launchd or the kit-watch workflow)",
      },
    ];
  }
  const ranked = cache.unverified
    ? `unverified: ${cache.unverified}`
    : `${cache.ranked.length} open security PR(s) ranked`;
  return [
    {
      category: "exposure",
      name: NAME,
      status: "pass",
      detail: `last kit watch run ${age(Math.max(0, elapsed))} ago; ${ranked}`,
    },
  ];
}
