/**
 * kit-research patching-what-you-build-vs-kit: a `kit watch` that last ran 40 days ago produced no
 * row in `kit check`; only Claude Code's status line showed `sec-prs:stale`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkWatchFreshness } from "./check-watch-freshness.js";
import { watchLaunchdLabel } from "./watch.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const NOW = Date.parse("2026-11-23T22:00:00Z");
const DAY = 86_400_000;

function dirs(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), "kit-watch-fresh-"));
  t.after(() => rmTemp(base));
  const cwd = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(join(cwd, ".kit"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const cache = (daysOld: number, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(cwd, ".kit", "watch.json"),
      JSON.stringify({
        at: new Date(NOW - daysOld * DAY).toISOString(),
        repo: "o/r",
        ranked: [],
        ...extra,
      }),
    );
  return { cwd, home, cache };
}

describe("checkWatchFreshness", () => {
  it("says nothing where the watch was never set up", (t) => {
    const { cwd, home } = dirs(t);
    assert.deepEqual(checkWatchFreshness(cwd, NOW, home), []);
  });

  it("passes a run from today, with its age", (t) => {
    const { cwd, home, cache } = dirs(t);
    cache(0.25);
    const [row] = checkWatchFreshness(cwd, NOW, home);
    assert.equal(row?.status, "pass");
    assert.equal(row?.detail, "last kit watch run 6 h ago; 0 open security PR(s) ranked");
  });

  it("warns on a run 40 days old, with the date and the command", (t) => {
    const { cwd, home, cache } = dirs(t);
    cache(40);
    const [row] = checkWatchFreshness(cwd, NOW, home);
    assert.equal(row?.status, "warn");
    assert.match(
      row?.detail ?? "",
      /^the last kit watch run was 40 days ago \(2026-10-14\): the daily run has stopped/,
    );
    assert.match(row?.suggestion ?? "", /kit watch run/);
  });

  it("warns when a scheduler entry exists but the watch never ran", (t) => {
    const { cwd, home } = dirs(t);
    mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".github", "workflows", "kit-watch.yml"), "name: kit-watch\n");
    const [workflow] = checkWatchFreshness(cwd, NOW, home);
    assert.match(
      workflow?.detail ?? "",
      /scheduled \(\.github\/workflows\/kit-watch\.yml\) but has never written/,
    );

    const { cwd: cwd2, home: home2 } = dirs(t);
    mkdirSync(join(home2, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      join(home2, "Library", "LaunchAgents", `${watchLaunchdLabel(cwd2)}.plist`),
      "<plist/>",
    );
    const [launchd] = checkWatchFreshness(cwd2, NOW, home2);
    assert.equal(launchd?.status, "warn");
    assert.match(launchd?.detail ?? "", /LaunchAgents/);
  });

  it("names an unverified run instead of a count", (t) => {
    const { cwd, home, cache } = dirs(t);
    cache(0.5, { unverified: "gh not authenticated" });
    assert.match(
      checkWatchFreshness(cwd, NOW, home)[0]?.detail ?? "",
      /unverified: gh not authenticated/,
    );
  });
});
