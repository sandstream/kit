import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CoolingDeps } from "./triage-cooling.js";
import {
  advisoryLines,
  failed,
  maliciousByName,
  osvLookup,
  plain,
  registryBase,
  releaseCooling,
  releaseVerdict,
} from "./triage-registry.js";

const NOW = Date.parse("2026-11-20T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function deps(answer: unknown, env: NodeJS.ProcessEnv = {}): CoolingDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    env,
    now: () => NOW,
    getJson: async () => null,
    postJson: async (url, body) => {
      asked.push(`${url} ${JSON.stringify(body)}`);
      return answer;
    },
    airGap: async () => ({ enabled: false, mirrors: {} }),
    asked,
  };
}

describe("registryBase", () => {
  it("prefers the named mirror, trims slashes, and is null under air-gap with no mirror", () => {
    const none = deps(null);
    const mirrored = deps(null, { KIT_X: " https://mirror.internal// " });
    assert.equal(
      registryBase(none, { enabled: false }, "KIT_X", "https://pub.example/"),
      "https://pub.example",
    );
    assert.equal(
      registryBase(mirrored, { enabled: false }, "KIT_X", "https://pub.example"),
      "https://mirror.internal",
    );
    assert.equal(
      registryBase(mirrored, { enabled: true }, "KIT_X", "https://pub.example"),
      "https://mirror.internal",
    );
    assert.equal(registryBase(none, { enabled: true }, "KIT_X", "https://pub.example"), null);
  });
});

describe("osvLookup and advisoryLines", () => {
  it("asks OSV for the ecosystem it was given", async () => {
    const d = deps({ vulns: [] });
    const osv = osvLookup(d, false, "crates.io");
    assert.deepEqual(await advisoryLines(osv, "ripgrep", "14.1.1"), []);
    assert.deepEqual(d.asked, [
      'https://api.osv.dev/v1/query {"package":{"name":"ripgrep","ecosystem":"crates.io"},"version":"14.1.1"}',
    ]);
  });

  it("a MAL- record is critical, any other record is a warning", async () => {
    const osv = osvLookup(
      deps({ vulns: [{ id: "MAL-1" }, { id: "GHSA-x" }, { bad: 1 }] }),
      false,
      "Go",
    );
    assert.deepEqual(await advisoryLines(osv, "m", "1.0.0"), [
      "  x CRITICAL: malicious package: MAL-1 (OSV)",
      "  ! WARNING: known vulnerabilities in 1.0.0: GHSA-x",
    ]);
  });

  it("says NOT CHECKED when OSV gives no answer, and when air-gap forbids asking", async () => {
    const silent = osvLookup(deps(null), false, "Go");
    assert.deepEqual(await advisoryLines(silent, "m", "1.0.0"), [
      "  ~ NOT CHECKED: advisories -- OSV could not be queried",
    ]);
    const closed = deps({ vulns: [] });
    assert.deepEqual(await advisoryLines(osvLookup(closed, true, "Go"), "m", "1.0.0"), [
      "  ~ NOT CHECKED: advisories -- air-gap is on and no KIT_OSV_API mirror is named",
    ]);
    assert.deepEqual(closed.asked, []);
  });
});

describe("maliciousByName", () => {
  it("names MAL- records for a package the registry no longer lists, and asks nothing under air-gap", async () => {
    const d = deps({ vulns: [{ id: "MAL-9" }, { id: "GHSA-y" }] });
    assert.deepEqual(await maliciousByName(d, false, "crates.io", "gone"), [
      "  x CRITICAL: malicious package: MAL-9 (OSV)",
    ]);
    assert.deepEqual(await maliciousByName(d, true, "crates.io", "gone"), []);
    assert.deepEqual(await maliciousByName(deps(null), false, "crates.io", "gone"), []);
  });
});

describe("releaseCooling and releaseVerdict", () => {
  const release = (age: number) => ({
    pkg: "tool",
    version: "1.0.0",
    versions: ["1.0.0"],
    times: { "1.0.0": daysAgo(age) },
    osv: { skipped: "not asked" },
  });

  it("holds a young release by default, and the hold is its own verdict", async () => {
    const cooling = await releaseCooling("/nonexistent", deps(null), release(1));
    assert.equal(cooling.held, true);
    const result = releaseVerdict(["  . triaged 1.0.0", ...cooling.lines], cooling);
    assert.equal(result.passed, false);
    assert.match(result.output, /Critical issues: 0\nWarnings: 0\nTRIAGE HELD: cooling period$/);
  });

  it("takes the limit and the enforcement from the environment", async () => {
    const warned = await releaseCooling(
      "/nonexistent",
      deps(null, { KIT_COOLING_ENFORCE: "0" }),
      release(1),
    );
    assert.equal(warned.held, false);
    assert.match(releaseVerdict(warned.lines, warned).output, /Warnings: 1\nTRIAGE PASSED$/);
    const short = await releaseCooling(
      "/nonexistent",
      deps(null, { KIT_MIN_RELEASE_AGE_DAYS: "1" }),
      release(2),
    );
    assert.deepEqual(short, { lines: [], held: false });
  });

  it("fails on a critical line that is not the cooling hold", () => {
    const result = releaseVerdict(["  x CRITICAL: malicious package: MAL-1 (OSV)"], {
      lines: [],
      held: false,
    });
    assert.equal(result.passed, false);
    assert.match(result.output, /Critical issues: 1\nWarnings: 0\nTRIAGE FAILED$/);
  });
});

describe("plain and failed", () => {
  it("prints registry text on one line and ends a stopped triage with the verdict", () => {
    assert.equal(plain("a\nb\u001b[31m"), "a?b?[31m");
    assert.equal(plain("x".repeat(200)).length, 80);
    assert.deepEqual(failed("  x CRITICAL: nope"), {
      passed: false,
      output: "  x CRITICAL: nope\n\nTRIAGE FAILED",
    });
  });
});
