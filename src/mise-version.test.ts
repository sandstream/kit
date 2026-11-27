import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMiseVersion } from "./mise-version.js";
import type { CoolingDeps } from "./triage-cooling.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-27T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

/** Fake registry deps: no network, no exec. `docs` maps a URL suffix to the JSON document. */
function deps(docs: Record<string, unknown>, over: Partial<CoolingDeps> = {}) {
  const urls: string[] = [];
  const d: CoolingDeps = {
    env: {},
    now: () => NOW,
    getJson: async (url) => {
      urls.push(url);
      const hit = Object.entries(docs).find(([k]) => url.endsWith(k));
      return hit ? hit[1] : null;
    },
    postJson: async () => null,
    airGap: async () => ({ enabled: false, mirrors: {} }),
    ...over,
  };
  return { d, urls };
}

const npmDoc = {
  versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {}, "2.0.0-beta.1": {} },
  time: {
    created: ago(400),
    modified: ago(1),
    "1.0.0": ago(300),
    "1.1.0": ago(20),
    "1.2.0": ago(3),
    "2.0.0-beta.1": ago(30),
  },
};

function withProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "kit-mise-version-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("resolveMiseVersion", () => {
  it("leaves an exact pin alone and asks no registry", async () => {
    const { d, urls } = deps({});
    const r = await resolveMiseVersion("npm:snyk", "1.1305.1", "/nowhere", d);
    assert.deepEqual(r, { kind: "pinned", version: "1.1305.1" });
    assert.equal(urls.length, 0);
  });

  it("resolves npm latest to the newest stable release public for 14 days", async () => {
    await withProject(async (dir) => {
      const { d, urls } = deps({ "/@socketsecurity/cli": npmDoc });
      const r = await resolveMiseVersion("npm:@socketsecurity/cli", "latest", dir, d);
      assert.equal(r.kind, "resolved");
      assert.equal(r.kind === "resolved" && r.version, "1.1.0");
      assert.match(urls[0], /^https:\/\/registry\.npmjs\.org\/@socketsecurity\/cli$/);
    });
  });

  it("honours min_release_age_days from .kit.toml", async () => {
    await withProject(async (dir) => {
      writeFileSync(join(dir, ".kit.toml"), "[supply_chain]\nmin_release_age_days = 2\n");
      const { d } = deps({ "/snyk": npmDoc });
      const r = await resolveMiseVersion("npm:snyk", "latest", dir, d);
      assert.equal(r.kind === "resolved" && r.version, "1.2.0");
    });
  });

  it("resolves pipx latest through the PyPI JSON API", async () => {
    await withProject(async (dir) => {
      const pypi = {
        releases: {
          "1.90.0": [{ upload_time_iso_8601: ago(40) }],
          "1.91.0": [{ upload_time_iso_8601: ago(5) }],
        },
      };
      const { d, urls } = deps({ "/semgrep/json": pypi });
      const r = await resolveMiseVersion("pipx:semgrep", "latest", dir, d);
      assert.equal(r.kind === "resolved" && r.version, "1.90.0");
      assert.match(urls[0], /pypi\.org\/pypi\/semgrep\/json$/);
    });
  });

  it("refuses (fail closed) when the registry cannot be read, and never returns latest", async () => {
    await withProject(async (dir) => {
      const { d } = deps({});
      const r = await resolveMiseVersion("npm:snyk", "latest", dir, d);
      assert.equal(r.kind, "refused");
      assert.match(r.kind === "refused" ? r.reason : "", /registry could not be read/);
      assert.match(r.kind === "refused" ? r.reason : "", /pin an exact version/);
    });
  });

  it("refuses when no stable release has cooled yet", async () => {
    await withProject(async (dir) => {
      const young = { versions: { "0.1.0": {} }, time: { "0.1.0": ago(2) } };
      const { d } = deps({ "/fresh-pkg": young });
      const r = await resolveMiseVersion("npm:fresh-pkg", "latest", dir, d);
      assert.equal(r.kind, "refused");
      assert.match(r.kind === "refused" ? r.reason : "", /public for 14 days/);
    });
  });

  it("refuses under air-gap with no mirror instead of asking the public registry", async () => {
    await withProject(async (dir) => {
      const { d, urls } = deps(
        { "/snyk": npmDoc },
        { airGap: async () => ({ enabled: true, mirrors: {} }) },
      );
      const r = await resolveMiseVersion("npm:snyk", "latest", dir, d);
      assert.equal(r.kind, "refused");
      assert.equal(urls.length, 0);
    });
  });

  it("passes other backends through: mise resolves aqua/core latest without a package-manager shim", async () => {
    const { d, urls } = deps({});
    for (const tool of ["aqua:trufflesecurity/trufflehog", "node"]) {
      const r = await resolveMiseVersion(tool, "latest", "/nowhere", d);
      assert.deepEqual(r, { kind: "passthrough", version: "latest" });
    }
    assert.equal(urls.length, 0);
  });
});
