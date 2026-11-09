import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipName, pipSpecFromAt, pypiJsonUrl, pypiReleaseTimes } from "./triage-cooling-pypi.js";
import { applyCooling, type CoolingDeps } from "./triage-cooling.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-09T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("pipName", () => {
  it("reads the distribution name from the forms pip accepts", () => {
    assert.equal(pipName("semgrep"), "semgrep");
    assert.equal(pipName("semgrep==1.184.0"), "semgrep");
    assert.equal(pipName("requests[socks]>=2.31"), "requests");
    assert.equal(pipName("zope.interface~=6.0"), "zope.interface");
    assert.equal(pipName("semgrep@1.184.0"), null, "the npm form is translated before this");
    assert.equal(pipName("../local/path"), null);
  });
});

describe("pipSpecFromAt", () => {
  it("reads npm's name@version as pip's name==version, extras kept", () => {
    assert.equal(pipSpecFromAt("semgrep@1.184.0"), "semgrep==1.184.0");
    assert.equal(pipSpecFromAt("requests[socks]@2.31.0"), "requests[socks]==2.31.0");
    assert.equal(pipSpecFromAt("pkg@1.0.0rc1"), "pkg==1.0.0rc1");
  });

  it("leaves everything else alone, including a PEP 508 direct reference", () => {
    assert.equal(pipSpecFromAt("semgrep==1.184.0"), null);
    assert.equal(pipSpecFromAt("semgrep"), null);
    assert.equal(pipSpecFromAt("pkg @ https://example.com/pkg-1.0.tar.gz"), null);
    assert.equal(pipSpecFromAt("pkg@https://example.com/pkg.whl"), null);
    assert.equal(pipSpecFromAt("pkg@latest"), null);
  });
});

describe("pypiReleaseTimes", () => {
  it("dates a version by its earliest upload and skips empty and fully yanked versions", () => {
    const view = pypiReleaseTimes({
      releases: {
        "1.0.0": [
          { upload_time_iso_8601: "2026-01-02T00:00:00Z" },
          { upload_time_iso_8601: "2026-01-01T00:00:00Z" },
        ],
        "1.1.0": [],
        "1.2.0": [{ upload_time_iso_8601: "2026-03-01T00:00:00Z", yanked: true }],
        "1.3.0": [{ upload_time: "2026-04-01T00:00:00" }],
      },
    });
    assert.deepEqual(view, {
      versions: ["1.0.0", "1.3.0"],
      times: { "1.0.0": "2026-01-01T00:00:00Z", "1.3.0": "2026-04-01T00:00:00" },
    });
    assert.equal(pypiReleaseTimes({}), null);
    assert.equal(pypiReleaseTimes(null), null);
  });

  it("builds the JSON API URL on any PyPI-compatible index", () => {
    assert.equal(pypiJsonUrl("https://pypi.org", "semgrep"), "https://pypi.org/pypi/semgrep/json");
    assert.equal(
      pypiJsonUrl("https://mirror.example/", "a b"),
      "https://mirror.example/pypi/a%20b/json",
    );
  });
});

describe("applyCooling for pip", () => {
  const report = (v: string) =>
    `Triage: pip fixture\n  . triaged ${v}, 3 releases, author: x\n\nHealth score: 88/100\nTRIAGE PASSED\n`;
  const doc = {
    releases: {
      "1.0.0": [{ upload_time_iso_8601: ago(60) }],
      "1.1.0": [{ upload_time_iso_8601: ago(3) }],
    },
  };
  function deps(env: NodeJS.ProcessEnv = {}, airGap = false): CoolingDeps & { urls: string[] } {
    const urls: string[] = [];
    return {
      urls,
      env,
      now: () => NOW,
      getJson: async (url) => {
        urls.push(url);
        return doc;
      },
      postJson: async () => ({ vulns: [] }),
      airGap: async () => ({ enabled: airGap, mirrors: {} }),
    };
  }

  it("warns about a release younger than the limit and names pip's spelling of an older one", async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-cooling-pip-"));
    t.after(() => rmTemp(cwd));
    const d = deps();
    const r = await applyCooling(
      cwd,
      "pip",
      "fixture==1.1.0",
      { passed: true, output: report("1.1.0") },
      d,
    );
    assert.equal(r.passed, true, "a warning, not a hold, by default");
    assert.match(r.output, /WARNING: cooling: 1\.1\.0 was published 3 days ago, limit 14/);
    assert.match(r.output, /fixture==1\.0\.0/);
    assert.deepEqual(d.urls, ["https://pypi.org/pypi/fixture/json"]);
  });

  it("holds the pass when cooling is enforced, and is silent for an old release", async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-cooling-pip-"));
    t.after(() => rmTemp(cwd));
    const held = await applyCooling(
      cwd,
      "pip",
      "fixture",
      { passed: true, output: report("1.1.0") },
      deps({ KIT_COOLING_ENFORCE: "1" }),
    );
    assert.equal(held.passed, false);
    assert.match(held.output, /TRIAGE HELD: cooling period/);
    const old = { passed: true, output: report("1.0.0") };
    assert.deepEqual(await applyCooling(cwd, "pip", "fixture", old, deps()), old);
  });

  it("uses the declared PyPI mirror, and says why when air-gap names none", async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-cooling-pip-"));
    t.after(() => rmTemp(cwd));
    const viaMirror = deps({ KIT_PYPI_INDEX: "https://pypi.mirror.example" }, true);
    await applyCooling(cwd, "pip", "fixture", { passed: true, output: report("1.1.0") }, viaMirror);
    assert.deepEqual(viaMirror.urls, ["https://pypi.mirror.example/pypi/fixture/json"]);
    const blind = deps({}, true);
    const r = await applyCooling(
      cwd,
      "pip",
      "fixture",
      { passed: true, output: report("1.1.0") },
      blind,
    );
    assert.match(r.output, /no PyPI index mirror is named/);
    assert.deepEqual(blind.urls, []);
  });
});
