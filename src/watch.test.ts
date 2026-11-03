import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  cronLine,
  gatherWatch,
  launchdPlist,
  palTitlesFor,
  readWatchCache,
  writeWatchCache,
  watchSegment,
  watchWorkflow,
  type WatchCache,
} from "./watch.js";
import type { RankedPr } from "./security-prs.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ranked: RankedPr[] = [
  {
    number: 3,
    title: "bump vite from 6.4.1 to 6.4.5",
    severity: "critical",
    ci: "failing",
    updatedAt: "2026-11-01T00:00:00Z",
  },
  {
    number: 9,
    title: "bump lodash from 1 to 2",
    severity: "low",
    ci: "passing",
    updatedAt: "2026-11-01T00:00:00Z",
  },
];
const cache = (over: Partial<WatchCache> = {}): WatchCache => ({
  at: "2026-11-03T06:00:00Z",
  repo: "o/r",
  ranked,
  ...over,
});

describe("watchSegment", () => {
  it("is null without a cache", () => {
    assert.equal(watchSegment(null, NOW), null);
  });
  it("shows the ranked line for a fresh cache", () => {
    assert.equal(watchSegment(cache(), NOW), "sec-prs:2 critical #3 ci:failing");
  });
  it("is quiet for a fresh cache with no security PRs", () => {
    assert.equal(watchSegment(cache({ ranked: [] }), NOW), null);
  });
  it("says stale after 48 hours, never green", () => {
    assert.equal(
      watchSegment(cache({ at: "2026-10-30T00:00:00Z", ranked: [] }), NOW),
      "sec-prs:stale",
    );
  });
  it("says unverified when the advisories could not be read", () => {
    assert.equal(
      watchSegment(cache({ unverified: "no alert access", ranked: [] }), NOW),
      "sec-prs:unverified",
    );
  });
});

describe("palTitlesFor", () => {
  it("opens an item for critical and high PRs only", () => {
    assert.deepEqual(palTitlesFor(ranked, []), [
      "Security PR #3 (critical, ci:failing): bump vite from 6.4.1 to 6.4.5",
    ]);
  });
  it("skips a PR that already has an open item", () => {
    assert.deepEqual(
      palTitlesFor(ranked, ["Security PR #3 (critical, ci:pending): old title"]),
      [],
    );
  });
});

describe("gatherWatch", () => {
  const prsJson = JSON.stringify([
    {
      number: 3,
      title: "bump vite from 6.4.1 to 6.4.5",
      updatedAt: "2026-11-01T00:00:00Z",
      author: { login: "dependabot", is_bot: true },
      statusCheckRollup: [{ conclusion: "FAILURE", status: "COMPLETED" }],
    },
  ]);
  const alertsJson = JSON.stringify([
    {
      security_vulnerability: {
        package: { name: "vite" },
        first_patched_version: { identifier: "6.4.5" },
      },
      security_advisory: { severity: "critical" },
    },
  ]);
  const gh = (alerts: { ok: boolean; stdout: string }) => async (args: string[]) => {
    if (args[0] === "repo") return { ok: true, stdout: "o/r\n" };
    if (args[0] === "pr") return { ok: true, stdout: prsJson };
    return alerts;
  };

  it("ranks a PR that fixes an open advisory", async () => {
    const out = await gatherWatch(gh({ ok: true, stdout: alertsJson }), () => NOW);
    assert.equal(out.repo, "o/r");
    assert.equal(out.ranked[0]?.severity, "critical");
    assert.equal(out.ranked[0]?.ci, "failing");
    assert.equal(out.unverified, undefined);
  });

  it("is unverified, not empty-green, when the alert call fails", async () => {
    const out = await gatherWatch(gh({ ok: false, stdout: "" }), () => NOW);
    assert.match(out.unverified ?? "", /dependabot alerts/);
    assert.deepEqual(out.ranked, []);
  });

  it("is unverified when gh cannot name the repository", async () => {
    const out = await gatherWatch(
      async () => ({ ok: false, stdout: "" }),
      () => NOW,
    );
    assert.match(out.unverified ?? "", /repository/);
  });
});

describe("scheduler entries", () => {
  it("launchd plist runs `kit watch run` daily from the project and escapes XML", () => {
    const xml = launchdPlist({
      label: "com.sandstream.kit-watch.ab12",
      command: ["/usr/bin/node", "/opt/kit/cli.js"],
      cwd: "/p/a&b",
      hour: 7,
      minute: 15,
      logPath: "/p/a&b/.kit/watch.log",
    });
    assert.match(xml, /<string>com\.sandstream\.kit-watch\.ab12<\/string>/);
    assert.match(
      xml,
      /<string>\/usr\/bin\/node<\/string>\s*<string>\/opt\/kit\/cli\.js<\/string>\s*<string>watch<\/string>\s*<string>run<\/string>/,
    );
    assert.match(xml, /<key>Hour<\/key>\s*<integer>7<\/integer>/);
    assert.match(xml, /<key>Minute<\/key>\s*<integer>15<\/integer>/);
    assert.match(xml, /\/p\/a&amp;b/);
    assert.doesNotMatch(xml, /a&b/);
  });
  it("cron line quotes the project path", () => {
    assert.equal(
      cronLine({
        command: ["/usr/bin/node", "/opt/kit/cli.js"],
        cwd: "/p/my proj",
        hour: 7,
        minute: 15,
      }),
      "15 7 * * * cd '/p/my proj' && '/usr/bin/node' '/opt/kit/cli.js' watch run >/dev/null 2>&1",
    );
  });
  it("workflow runs daily and reads only", () => {
    const y = watchWorkflow();
    assert.match(y, /cron: "17 6 \* \* \*"/);
    assert.match(y, /kit watch run/);
    assert.match(y, /pull-requests: read/);
    assert.doesNotMatch(y, /write/);
  });
});

describe("watch cache on disk", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "kit-watch-"));

  it("round-trips a cache", () => {
    const dir = tmp();
    try {
      writeWatchCache(dir, cache());
      assert.deepEqual(readWatchCache(dir), cache());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlinked cache file or directory", () => {
    const dir = tmp();
    const victim = join(dir, "victim.txt");
    try {
      writeFileSync(victim, "keep");
      mkdirSync(join(dir, ".kit"));
      symlinkSync(victim, join(dir, ".kit", "watch.json"));
      assert.throws(() => writeWatchCache(dir, cache()), /symlink/);
      assert.equal(readFileSync(victim, "utf8"), "keep");
      rmSync(join(dir, ".kit"), { recursive: true });
      symlinkSync(dir, join(dir, ".kit"));
      assert.throws(() => writeWatchCache(dir, cache()), /symlink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops entries a planted cache fills with anything but known values", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, ".kit"));
      writeFileSync(
        join(dir, ".kit", "watch.json"),
        JSON.stringify({
          at: "2026-11-03T06:00:00Z",
          repo: "o/r",
          ranked: [
            { number: 3, title: "ok", severity: "critical", ci: "failing", updatedAt: "x" },
            { number: 4, title: "x", severity: "\u001b[2Jcritical", ci: "passing", updatedAt: "x" },
            { number: 5, title: "x", severity: "low", ci: "\u001b]0;pwn\u0007", updatedAt: "x" },
            { number: "6; rm", title: "x", severity: "low", ci: "none", updatedAt: "x" },
          ],
        }),
      );
      assert.deepEqual(
        readWatchCache(dir)?.ranked.map((r) => r.number),
        [3],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a cache that is not an object with a time", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, ".kit"));
      writeFileSync(join(dir, ".kit", "watch.json"), "[1,2]");
      assert.equal(readWatchCache(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
