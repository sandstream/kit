/**
 * The lookup that `latest` never made.
 *
 * `check-tools.ts` answered `if (required === "latest") return true;`, so `✓ vercel 53.1.1
 * (need latest)` printed while npm had 59.1.4 (#500). These tests pin the three properties that
 * make the replacement safe rather than merely present: a lookup that cannot run says so, an
 * installer kit cannot query says which, and a warm cache means the gate makes no network call.
 *
 * Nothing here touches a registry — the runner, clock and cache are injected.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  latestVersion,
  judgeDrift,
  compareVersions,
  parseBrewInfoVersion,
  firstVersion,
  latestCacheKey,
  type LatestCache,
  type LatestDeps,
} from "./tool-latest.js";

/** A fixed, realistic clock: TTL arithmetic has to happen on plausible epoch values. */
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function deps(
  over: Partial<LatestDeps> = {},
): LatestDeps & { cache: LatestCache; calls: string[] } {
  const cache: LatestCache = {};
  const calls: string[] = [];
  const inner = over.run ?? (async () => ({ ok: true, stdout: "1.2.3\n" }));
  const base: LatestDeps = {
    now: () => NOW,
    readCache: async () => cache,
    writeCache: async (c) => {
      for (const k of Object.keys(c)) cache[k] = c[k];
    },
    offline: false,
    ...over,
    // Wrap whatever runner the case supplied, so `calls` records every invocation — an
    // override used to bypass the recorder and made "did this shell out?" untestable.
    run: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return inner(cmd, args);
    },
  };
  return Object.assign(base, { cache, calls });
}

describe("latestVersion", () => {
  it("asks npm for an npm-global tool and caches the answer", async () => {
    const d = deps({ run: async () => ({ ok: true, stdout: "6.7.0\n" }) });
    const r = await latestVersion("sandstream-kit", "npm-global", d);
    assert.deepEqual(r, { status: "known", version: "6.7.0", via: "npm", cached: false });
    assert.equal(d.cache[latestCacheKey("sandstream-kit", "npm-global")]?.version, "6.7.0");
  });

  it("serves a warm cache without running anything — the gate must not need the network", async () => {
    const d = deps();
    d.cache["brew:vercel"] = { version: "59.1.4", at: NOW - HOUR, via: "brew" };
    const r = await latestVersion("vercel", "brew", d);
    assert.deepEqual(r, { status: "known", version: "59.1.4", via: "brew", cached: true });
    assert.deepEqual(d.calls, [], "a cache hit must not shell out");
  });

  it("re-asks once the TTL has passed", async () => {
    const d = deps({ run: async () => ({ ok: true, stdout: "59.1.4\n" }) });
    d.cache["mise:semgrep"] = { version: "1.167.0", at: NOW - 25 * HOUR, via: "mise" };
    const r = await latestVersion("semgrep", "mise", d);
    assert.equal(r.status === "known" && r.version, "59.1.4");
    assert.equal(r.status === "known" && r.cached, false);
    assert.deepEqual(d.calls, ["mise latest semgrep"]);
  });

  it("air-gap reports unavailable with a reason — never current", async () => {
    const d = deps({ offline: true });
    const r = await latestVersion("vercel", "brew", d);
    assert.equal(r.status, "unavailable");
    assert.match(r.status === "unavailable" ? r.reason : "", /air-gap\/offline/);
    assert.deepEqual(d.calls, [], "air-gap must make no outbound call");
  });

  it("air-gap says the cached answer is stale rather than serving it silently", async () => {
    const d = deps({ offline: true });
    d.cache["brew:vercel"] = { version: "58.0.0", at: NOW - 25 * HOUR, via: "brew" };
    const r = await latestVersion("vercel", "brew", d);
    assert.equal(r.status, "unavailable");
    assert.match(r.status === "unavailable" ? r.reason : "", /58\.0\.0/);
  });

  it("an installer with no registry is unsupported, and names itself", async () => {
    for (const source of ["system", "cargo", "go", "unknown"] as const) {
      const r = await latestVersion("git", source, deps());
      assert.equal(r.status, "unsupported", source);
      assert.match(r.status === "unsupported" ? r.reason : "", new RegExp(source));
    }
  });

  it("a kit shim is unsupported and says to resolve what it wraps", async () => {
    const r = await latestVersion("bun", "kit-shim", deps());
    assert.equal(r.status, "unsupported");
    assert.match(r.status === "unsupported" ? r.reason : "", /delegates/);
  });

  it("a failed lookup is unavailable and is NOT cached — a transient must not become policy", async () => {
    const d = deps({ run: async () => ({ ok: false, stdout: "" }) });
    const r = await latestVersion("vercel", "brew", d);
    assert.equal(r.status, "unavailable");
    assert.match(r.status === "unavailable" ? r.reason : "", /did not answer/);
    assert.deepEqual(Object.keys(d.cache), []);
  });

  it("an answer with no version in it is unavailable, not a pass", async () => {
    const d = deps({ run: async () => ({ ok: true, stdout: "Warning: nothing to report\n" }) });
    const r = await latestVersion("vercel", "brew", d);
    assert.equal(r.status, "unavailable");
    assert.match(r.status === "unavailable" ? r.reason : "", /no version could be read/);
  });

  it("reads brew's JSON rather than the first number in its chatter", () => {
    const json = JSON.stringify({
      formulae: [{ versions: { stable: "59.1.4" } }],
    });
    assert.equal(parseBrewInfoVersion(json), "59.1.4");
    assert.equal(parseBrewInfoVersion("not json"), null);
    assert.equal(firstVersion("mise 2026.8.9 something"), "2026.8.9");
  });
});

describe("compareVersions / judgeDrift", () => {
  it("compares numerically, not as strings", () => {
    // The case that mattered, and the one a string compare gets backwards.
    assert.equal(compareVersions("53.1.1", "59.1.4"), -1);
    assert.equal(compareVersions("9.0.0", "10.0.0"), -1);
    assert.equal(compareVersions("1.173.0", "1.167.0"), 1);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
    assert.equal(compareVersions("v6.7.0", "6.7.0"), 0);
    assert.equal(compareVersions("weird-build", "1.0.0"), null);
  });

  it("behind is the six-majors case, reported with both numbers", () => {
    const v = judgeDrift("53.1.1", {
      status: "known",
      version: "59.1.4",
      via: "brew",
      cached: true,
    });
    assert.deepEqual(v, { drift: "behind", installed: "53.1.1", latest: "59.1.4" });
  });

  it("ahead is a warning, not an error — a newer local build is not a defect", () => {
    const v = judgeDrift("2.0.0", { status: "known", version: "1.9.0", via: "npm", cached: false });
    assert.equal(v.drift, "ahead");
  });

  it("carries the lookup's own reason through when it could not run", () => {
    const v = judgeDrift("1.0.0", {
      status: "unavailable",
      reason: "air-gap/offline: nothing cached",
    });
    assert.deepEqual(v, { drift: "unknown", reason: "air-gap/offline: nothing cached" });
  });

  it("a missing tool is unknown drift, not behind", () => {
    const v = judgeDrift(null, { status: "known", version: "1.0.0", via: "npm", cached: true });
    assert.deepEqual(v, { drift: "unknown", reason: "tool not installed" });
  });

  it("an unparseable installed version does not pass as current", () => {
    const v = judgeDrift("nightly", {
      status: "known",
      version: "1.0.0",
      via: "npm",
      cached: true,
    });
    assert.equal(v.drift, "unknown");
    assert.match(v.drift === "unknown" ? v.reason : "", /cannot compare/);
  });
});
