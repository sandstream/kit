import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  gemRegistryView,
  lockedGemVersion,
  parseGemTarget,
  triageGem,
  type GemTriageDeps,
} from "./triage-gem.js";

const NOW = Date.parse("2026-11-01T06:05:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

/** Deps with a canned registry document and OSV answer; records what was asked. */
function deps(
  doc: unknown,
  vulns: { id: string }[] = [],
  over: Partial<GemTriageDeps> = {},
): GemTriageDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    env: {},
    now: () => NOW,
    getJson: async (url) => (asked.push(url), doc),
    postJson: async (url, body) => (asked.push(`${url} ${JSON.stringify(body)}`), { vulns }),
    airGap: async () => ({ enabled: false, mirrors: {} }),
    lockfile: () => null,
    asked,
    ...over,
  };
}

/** The strutil-core timeline: a clean 1.0.0, then 1.0.1 under two hours later. */
const STRUTIL = [
  {
    number: "1.0.1",
    created_at: hoursAgo(0.1),
    prerelease: false,
    downloads_count: 3,
    metadata: {},
  },
  {
    number: "1.0.0",
    created_at: hoursAgo(1.9),
    prerelease: false,
    downloads_count: 9,
    metadata: {},
  },
];

describe("parseGemTarget", () => {
  it("reads name and name@version, and refuses anything else", () => {
    assert.deepEqual(parseGemTarget("rake"), { name: "rake" });
    assert.deepEqual(parseGemTarget("rails@8.0.1"), { name: "rails", version: "8.0.1" });
    for (const bad of ["", "-rf", "a@b@c", "x@", "x@;rm", "../x"])
      assert.equal(parseGemTarget(bad), null, bad);
  });
});

describe("gemRegistryView", () => {
  it("lists each version once, at its earliest platform, and sums downloads", () => {
    const v = gemRegistryView([
      { number: "1.2.0", created_at: daysAgo(3), platform: "x86_64-linux", downloads_count: 5 },
      { number: "1.2.0", created_at: daysAgo(4), platform: "ruby", downloads_count: 7 },
      {
        number: "1.1.0",
        created_at: daysAgo(90),
        downloads_count: 100,
        metadata: { rubygems_mfa_required: "true" },
      },
    ]);
    assert.deepEqual(v?.versions, ["1.2.0", "1.1.0"]);
    assert.equal(v?.times["1.2.0"], daysAgo(4));
    assert.equal(v?.downloads, 112);
    assert.equal(v?.mfaRequired["1.1.0"], true);
  });
  it("is null for anything that is not a versions list", () => {
    assert.equal(gemRegistryView({ error: "not found" }), null);
    assert.equal(gemRegistryView([]), null);
  });
});

describe("lockedGemVersion", () => {
  const lock =
    "GEM\n  remote: https://rubygems.org/\n  specs:\n    nokogiri (1.18.10-x86_64-linux)\n    rake (13.4.2)\n";
  it("reads the version Gemfile.lock pins, without the platform suffix", () => {
    assert.equal(lockedGemVersion(lock, "rake"), "13.4.2");
    assert.equal(lockedGemVersion(lock, "nokogiri"), "1.18.10");
    assert.equal(lockedGemVersion(lock, "rails"), undefined);
    assert.equal(lockedGemVersion(null, "rake"), undefined);
  });
});

describe("triageGem", () => {
  it("fails strutil-core 1.0.1 on its OSV malicious record, and warns on its age", async () => {
    const d = deps(STRUTIL, [{ id: "MAL-2026-19054" }]);
    const r = await triageGem("/nonexistent", "strutil-core", d);
    assert.equal(r.passed, false);
    assert.match(r.output, /triaged 1\.0\.1/);
    assert.match(r.output, /x CRITICAL: malicious package: MAL-2026-19054 \(OSV\)/);
    assert.match(r.output, /! WARNING: cooling: 1\.0\.1 was published 0 days ago, limit 14/);
    assert.match(r.output, /! WARNING: new gem: first published 0 day\(s\) ago/);
    assert.match(r.output, /TRIAGE FAILED$/);
  });

  it("holds the same release on cooling alone, before any advisory exists, when enforcement is on", async () => {
    const d = deps(STRUTIL, [], { env: { KIT_COOLING_ENFORCE: "1" } });
    const r = await triageGem("/nonexistent", "strutil-core", d);
    assert.equal(r.passed, false);
    assert.match(r.output, /x CRITICAL: cooling: 1\.0\.1 was published 0 days ago/);
    assert.match(r.output, /TRIAGE HELD: cooling period$/);
  });

  it("passes an old, much-used release and says what it did not read", async () => {
    const doc = [
      {
        number: "13.4.2",
        created_at: daysAgo(200),
        downloads_count: 5_000_000,
        metadata: { rubygems_mfa_required: "true" },
      },
      { number: "14.0.0.beta1", created_at: daysAgo(1), prerelease: true, downloads_count: 10 },
    ];
    const r = await triageGem("/nonexistent", "rake", deps(doc));
    assert.equal(r.passed, true, r.output);
    assert.match(r.output, /triaged 13\.4\.2/, "a prerelease is not what gem install takes");
    assert.match(r.output, /NOT CHECKED: install-time code/);
    assert.match(r.output, /TRIAGE PASSED$/);
  });

  it("names OSV's malicious record when the registry has already removed the gem", async () => {
    const r = await triageGem(
      "/nonexistent",
      "strutil-core",
      deps(null, [{ id: "MAL-2026-19054" }]),
    );
    assert.equal(r.passed, false);
    assert.match(
      r.output,
      /not found on https:\/\/rubygems\.org\n {2}x CRITICAL: malicious package: MAL-2026-19054/,
    );
  });

  it("fails a version that is not published", async () => {
    const r = await triageGem("/nonexistent", "strutil-core@9.9.9", deps(STRUTIL));
    assert.match(r.output, /strutil-core@9\.9\.9 is not published \(or was yanked\)/);
  });

  it("under air-gap asks nothing without a mirror, and uses the mirror when one is named", async () => {
    const off = deps(STRUTIL, [], { airGap: async () => ({ enabled: true, mirrors: {} }) });
    const r = await triageGem("/nonexistent", "rake", off);
    assert.equal(r.passed, false);
    assert.deepEqual(off.asked, []);
    const mirrored = deps(STRUTIL, [], {
      env: { KIT_RUBYGEMS_SOURCE: "https://gems.internal/", KIT_OSV_API: "https://osv.internal" },
      airGap: async () => ({ enabled: true, mirrors: {} }),
    });
    await triageGem("/nonexistent", "strutil-core", mirrored);
    assert.ok(
      mirrored.asked[0].startsWith("https://gems.internal/api/v1/versions/strutil-core.json"),
    );
    assert.ok(mirrored.asked.slice(1).every((a) => a.startsWith("https://osv.internal/v1/query")));
  });
});
