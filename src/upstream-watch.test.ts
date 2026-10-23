import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluate,
  needsAttention,
  normalizePath,
  observe,
  renderReport,
  versionsDiffer,
  type FetchJson,
  type WatchEntry,
} from "./upstream-watch.js";

const ROOT = join(import.meta.dirname, "..");
const fake =
  (responses: Record<string, unknown>): FetchJson =>
  async (url) => {
    if (!(url in responses)) throw new Error(`GET ${url} returned HTTP 404`);
    return responses[url];
  };

describe("versionsDiffer", () => {
  it("compares at the tracked granularity", () => {
    assert.strictEqual(versionsDiffer("5.1.2", "5.4.2", "major"), false);
    assert.strictEqual(versionsDiffer("5.1.2", "5.4.2", "minor"), true);
    assert.strictEqual(versionsDiffer("v2.15.1", "2.15.1"), false);
    assert.strictEqual(versionsDiffer("17.5.0", "23.0.1", "major"), true);
  });

  it("treats a 0.x minor as the major step", () => {
    assert.strictEqual(versionsDiffer("v0.3.10", "v0.3.200", "major"), false);
    assert.strictEqual(versionsDiffer("v0.3.10", "v0.4.0", "major"), true);
  });

  it("compares non-numeric versions exactly", () => {
    assert.strictEqual(versionsDiffer("nightly", "nightly"), false);
    assert.strictEqual(versionsDiffer("nightly", "stable"), true);
  });
});

describe("normalizePath", () => {
  it("makes code templates and spec parameters comparable", () => {
    assert.strictEqual(
      normalizePath("/v9/projects/${encodeURIComponent(id)}/env"),
      normalizePath("/v9/projects/{idOrName}/env"),
    );
    assert.strictEqual(normalizePath("/v1/projects/?limit=1"), "/v1/projects");
  });
});

describe("observe", () => {
  it("reads npm latest and reports a deprecated latest as dead", async () => {
    const o = await observe(
      { kind: "npm", package: "@scope/tool" },
      fake({
        "https://registry.npmjs.org/%40scope%2Ftool": {
          "dist-tags": { latest: "2.0.0" },
          versions: { "2.0.0": { deprecated: "use other-tool" } },
        },
      }),
    );
    assert.strictEqual(o.version, "2.0.0");
    assert.match(o.dead[0], /deprecated: use other-tool/);
  });

  it("reports an archived GitHub repo as dead", async () => {
    const o = await observe(
      { kind: "github-release", repo: "o/r" },
      fake({
        "https://api.github.com/repos/o/r": { archived: true },
        "https://api.github.com/repos/o/r/releases/latest": { tag_name: "v1.2.3" },
      }),
    );
    assert.deepStrictEqual([o.version, o.dead], ["v1.2.3", ["o/r is archived"]]);
  });

  it("reports a pinned API version that left the supported list as dead", async () => {
    const url = "https://api.snyk.io/rest/openapi";
    const live = await observe(
      { kind: "api-versions", url, pinned: "2024-10-15" },
      fake({ [url]: ["2024-10-15", "2026-03-25", "2026-04-01~beta"] }),
    );
    assert.deepStrictEqual([live.version, live.dead], ["2026-03-25", []]);
    const gone = await observe(
      { kind: "api-versions", url, pinned: "2022-11-28" },
      fake({ [url]: ["2026-03-25"] }),
    );
    assert.match(gone.dead[0], /2022-11-28 is no longer listed/);
  });

  it("reports a called path missing from the spec as dead, unless acknowledged", async () => {
    const url = "https://openapi.vercel.sh/";
    const fetchJson = fake({ [url]: { paths: { "/v10/projects/{id}/env": {} } } });
    const o = await observe(
      {
        kind: "openapi-paths",
        url,
        paths: ["/v10/projects/{x}/env", "/v9/projects", "/v6/deployments"],
        acknowledged: { "/v6/deployments": "still served" },
      },
      fetchJson,
    );
    assert.deepStrictEqual(o.dead, ["/v9/projects is absent from the vendor's published spec"]);
    assert.match(
      o.notes[0],
      /\/v6\/deployments absent from the spec \(acknowledged: still served\)/,
    );
  });
});

describe("observe refuses what it should not touch", () => {
  const never: FetchJson = async () => {
    throw new Error("must not be fetched");
  };

  it("refuses a host outside WATCH_HOSTS before fetching", async () => {
    await assert.rejects(
      observe({ kind: "api-versions", url: "https://evil.example/versions", pinned: "x" }, never),
      /not an https URL on a watched host/,
    );
    await assert.rejects(
      observe({ kind: "openapi-paths", url: "http://openapi.vercel.sh/", paths: [] }, never),
      /not an https URL on a watched host/,
    );
  });

  it("refuses a malformed package name or repo before building a URL", async () => {
    await assert.rejects(observe({ kind: "pypi", package: "../x" }, never), /malformed name/);
    await assert.rejects(
      observe({ kind: "github-release", repo: "o/r/../../x" }, never),
      /malformed name/,
    );
  });

  it("refuses a version string that does not look like a version", async () => {
    const fetchJson = fake({
      "https://pypi.org/pypi/x/json": { info: { version: "1.0 <img src=x>" } },
    });
    await assert.rejects(observe({ kind: "pypi", package: "x" }, fetchJson), /malformed version/);
  });
});

describe("evaluate", () => {
  const entry = (over: Partial<WatchEntry> = {}): WatchEntry => ({
    id: "x",
    owner: "f.ts",
    source: { kind: "npm", package: "x" },
    ...over,
  });
  const seen = (version: string) => ({ version, dead: [], notes: [] });

  it("never passes a failed lookup", () => {
    const r = evaluate(entry(), null, "HTTP 401");
    assert.deepStrictEqual([r.state, r.detail], ["lookup-failed", "HTTP 401"]);
  });

  it("distinguishes unobserved, unchanged and changed", () => {
    assert.strictEqual(evaluate(entry(), seen("1.0.0")).state, "unobserved");
    const base = {
      baseline: { version: "1.0.0", observedAt: "2026-10-23" },
      track: "major" as const,
    };
    assert.strictEqual(evaluate(entry(base), seen("1.9.0")).state, "unchanged");
    const changed = evaluate(entry(base), seen("2.0.0"));
    assert.strictEqual(changed.state, "changed");
    assert.match(changed.detail, /1\.0\.0 → 2\.0\.0 since 2026-10-23/);
  });

  it("puts dead above everything and says when kit pins latest", () => {
    const r = evaluate(entry({ pinned: "latest" }), {
      version: "1.0.0",
      dead: ["gone"],
      notes: [],
    });
    assert.strictEqual(r.state, "dead");
    assert.match(r.detail, /unpinned/);
  });

  it("lists a declared not-watchable entry without asking for attention", () => {
    const r = evaluate(entry({ source: { kind: "none", reason: "private API" } }), null);
    assert.strictEqual(r.state, "not-watchable");
    assert.deepStrictEqual(needsAttention([r]), []);
    assert.match(renderReport([r], "2026-10-23"), /private API/);
  });

  it("escapes table syntax and drops control characters in report cells", () => {
    const r = evaluate(entry({ source: { kind: "none", reason: "a\\|b\nc" } }), null);
    assert.match(renderReport([r], "2026-10-23"), /a\\\\\\\|b c/);
  });
});

// The contract is only worth something if it matches the code it describes.
describe("contracts/upstream-watch.json", () => {
  const contract = JSON.parse(
    readFileSync(join(ROOT, "contracts", "upstream-watch.json"), "utf8"),
  ) as { entries: WatchEntry[] };
  const source = (file: string) => readFileSync(join(ROOT, file), "utf8");

  it("names an owner file that exists for every entry, with unique ids", () => {
    const ids = contract.entries.map((e) => e.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const e of contract.entries) assert.doesNotThrow(() => source(e.owner), e.owner);
  });

  it("pins the API version the plugin actually sends", () => {
    for (const e of contract.entries) {
      if (e.source.kind !== "api-versions") continue;
      assert.ok(source(e.owner).includes(`"${e.source.pinned}"`), `${e.id} ↔ ${e.owner}`);
    }
  });

  it("declares exactly the versioned paths the plugin calls", () => {
    for (const e of contract.entries) {
      if (e.source.kind !== "openapi-paths") continue;
      const called = new Set(
        [...source(e.owner).matchAll(/\/v\d+\/[^`"'?\s]+/g)].map((m) =>
          normalizePath(m[0].replace(/\$\{client\.\w+\}.*$|\$\{sep\}.*$/, "")),
        ),
      );
      const declared = new Set(e.source.paths.map(normalizePath));
      assert.deepStrictEqual([...declared].sort(), [...called].sort(), e.id);
      for (const path of Object.keys(e.source.acknowledged ?? {})) {
        assert.ok(e.source.paths.includes(path), `${e.id}: acknowledged ${path} is not declared`);
      }
    }
  });
});
