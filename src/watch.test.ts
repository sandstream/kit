import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  cronLine,
  gatherWatch,
  kevLookupFor,
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

describe("gatherWatch", () => {
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

describe("gatherWatch: CISA KEV", () => {
  it("marks and ranks first a PR that fixes a CVE in CISA KEV", async () => {
    const prs = JSON.stringify([
      JSON.parse(prsJson)[0],
      {
        number: 4,
        title: "bump lodash from 4.17.11 to 4.17.21",
        updatedAt: "2026-11-02T00:00:00Z",
        author: { login: "dependabot", is_bot: true },
        statusCheckRollup: [],
      },
    ]);
    const alerts = JSON.stringify([
      JSON.parse(alertsJson)[0],
      {
        security_vulnerability: {
          package: { name: "lodash" },
          first_patched_version: { identifier: "4.17.21" },
        },
        security_advisory: { severity: "medium", cve_id: "cve-2021-23337" },
      },
    ]);
    const asked: string[][] = [];
    const out = await gatherWatch(
      async (args) =>
        args[0] === "repo"
          ? { ok: true, stdout: "o/r\n" }
          : args[0] === "pr"
            ? { ok: true, stdout: prs }
            : { ok: true, stdout: alerts },
      () => NOW,
      async (cves) => {
        asked.push(cves);
        return { kev: new Set(["CVE-2021-23337"]) };
      },
    );
    assert.deepEqual(asked, [["CVE-2021-23337"]]);
    assert.deepEqual(
      out.ranked.map((r) => [r.number, r.severity, r.kev ?? false]),
      [
        [4, "medium", true],
        [3, "critical", false],
      ],
    );
    assert.equal(out.kevNote, undefined);
    assert.equal(watchSegment(out, NOW), "sec-prs:2 KEV medium #4 ci:none");
    assert.deepEqual(palTitlesFor(out.ranked, []), [
      "Security PR #4 (KEV, medium, ci:none): bump lodash to 4.17.21",
      "Security PR #3 (critical, ci:failing): bump vite to 6.4.5",
    ]);
    // The mark survives the cache round trip.
    const dir = mkdtempSync(join(tmpdir(), "kit-watch-kev-"));
    try {
      writeWatchCache(dir, out);
      assert.equal(readWatchCache(dir)?.ranked[0]?.kev, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the ranking and records why when KEV cannot be checked", async () => {
    const out = await gatherWatch(
      gh({ ok: true, stdout: alertsJson }),
      () => NOW,
      async () => ({ kev: new Set(), note: "CISA KEV could not be fetched: HTTP 503" }),
    );
    assert.equal(out.ranked.length, 1);
    assert.equal(out.kevNote, "CISA KEV could not be fetched: HTTP 503");
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

describe("kevLookupFor: project settings", () => {
  async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const keys = ["KIT_EXPLOIT_INTEL", "KIT_EXPLOIT_INTEL_CACHE", "KIT_AIRGAP"];
    const saved = keys.map((k) => process.env[k]);
    keys.forEach((k) => delete process.env[k]);
    Object.assign(process.env, env);
    try {
      return await fn();
    } finally {
      keys.forEach((k, i) =>
        saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]),
      );
    }
  }
  const noCache = join(tmpdir(), `kit-no-intel-${process.pid}.json`);

  it("is off with [scan] exploit_intel = false", async () => {
    const r = await withEnv({ KIT_EXPLOIT_INTEL_CACHE: noCache }, () =>
      kevLookupFor({ scan: { exploit_intel: false } })(["CVE-2021-44228"]),
    );
    assert.deepEqual(r, { kev: new Set() });
  });

  it("honors [air_gap] enabled from config: no fetch, a note instead", async () => {
    const r = await withEnv({ KIT_EXPLOIT_INTEL_CACHE: noCache }, () =>
      kevLookupFor({ air_gap: { enabled: true } })(["CVE-2021-44228"]),
    );
    assert.equal(r.kev.size, 0);
    assert.match(r.note ?? "", /air gap/);
  });
});
