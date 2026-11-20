import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DepGraph, GraphNode } from "./dependency-surface.js";
import {
  advisoriesPerDirect,
  loadAdvisories,
  type AdvisoryDeps,
} from "./dependency-surface-advisories.js";

const PKGS = [
  { name: "lodash", version: "4.17.20" },
  { name: "zod", version: "4.1.0" },
  { name: "clean", version: "1.0.0" },
];

const KNOWN: Record<string, { id: string }[]> = {
  lodash: [{ id: "GHSA-aaaa-bbbb-cccc" }, { id: "GHSA-dddd-eeee-ffff" }],
  zod: [{ id: "GHSA-gggg-hhhh-iiii" }],
};

/** What OSV would say: an answer per query, in order. */
function answer(body: string): string {
  const { queries } = JSON.parse(body) as { queries: { package: { name: string } }[] };
  return JSON.stringify({
    results: queries.map((q) => (KNOWN[q.package.name] ? { vulns: KNOWN[q.package.name] } : {})),
  });
}

function fakeDeps(over: Partial<AdvisoryDeps> = {}): AdvisoryDeps & {
  posts: { url: string; body: string }[];
  cache: { raw: string | null };
  clock: { now: number };
} {
  const posts: { url: string; body: string }[] = [];
  const cache = { raw: null as string | null };
  const clock = { now: Date.parse("2026-11-20T12:00:00Z") };
  return {
    posts,
    cache,
    clock,
    offline: false,
    now: () => clock.now,
    post: async (url, body) => {
      posts.push({ url, body });
      return answer(body);
    },
    readCache: () => cache.raw,
    writeCache: (raw) => {
      cache.raw = raw;
    },
    ...over,
  };
}

describe("loadAdvisories", () => {
  it("asks OSV once for all packages and maps each answer to its package", async () => {
    const deps = fakeDeps();
    const got = await loadAdvisories(PKGS, deps);
    assert.equal(deps.posts.length, 1);
    assert.match(deps.posts[0].url, /api\.osv\.dev\/v1\/querybatch$/);
    const sent = JSON.parse(deps.posts[0].body) as { queries: unknown[] };
    assert.equal(sent.queries.length, 3);
    assert.deepEqual(sent.queries[0], {
      package: { name: "lodash", ecosystem: "npm" },
      version: "4.17.20",
    });
    assert.deepEqual(got.found.get("lodash@4.17.20"), [
      "GHSA-aaaa-bbbb-cccc",
      "GHSA-dddd-eeee-ffff",
    ]);
    assert.equal(got.found.has("clean@1.0.0"), false);
    assert.equal(got.checked, true);
  });

  it("splits a long list into batches of at most 1000", async () => {
    const deps = fakeDeps({
      post: async (_u, body) => {
        const n = (JSON.parse(body) as { queries: unknown[] }).queries.length;
        return JSON.stringify({ results: Array.from({ length: n }, () => ({})) });
      },
    });
    const many = Array.from({ length: 2300 }, (_, i) => ({ name: `p${i}`, version: "1.0.0" }));
    const got = await loadAdvisories(many, deps);
    assert.equal(got.checked, true);
  });

  it("answers from the cache for 24 hours and asks again after that", async () => {
    const deps = fakeDeps();
    await loadAdvisories(PKGS, deps);
    await loadAdvisories(PKGS, deps);
    assert.equal(deps.posts.length, 1, "second run used the cache");
    deps.clock.now += 25 * 3_600_000;
    await loadAdvisories(PKGS, deps);
    assert.equal(deps.posts.length, 2, "stale cache is asked again");
  });

  it("asks only for the packages the cache does not hold", async () => {
    const deps = fakeDeps();
    await loadAdvisories(PKGS.slice(0, 2), deps);
    await loadAdvisories(PKGS, deps);
    const sent = JSON.parse(deps.posts[1].body) as { queries: { package: { name: string } }[] };
    assert.deepEqual(
      sent.queries.map((q) => q.package.name),
      ["clean"],
    );
  });
});

describe("loadAdvisories when it cannot ask", () => {
  it("makes no request in an air gap, and reads the cache it has", async () => {
    const online = fakeDeps();
    await loadAdvisories(PKGS, online);
    const off = fakeDeps({ offline: true, readCache: () => online.cache.raw });
    const got = await loadAdvisories(PKGS, off);
    assert.equal(off.posts.length, 0);
    assert.equal(got.found.get("zod@4.1.0")?.length, 1);
    assert.equal(got.checked, true);
  });

  it("says it did not check when it is offline and the cache is empty", async () => {
    const off = fakeDeps({ offline: true });
    const got = await loadAdvisories(PKGS, off);
    assert.equal(got.checked, false);
    assert.match(got.note ?? "", /air gap|offline/i);
  });

  it("says it did not check when the request fails, and keeps what the cache held", async () => {
    const deps = fakeDeps();
    await loadAdvisories(PKGS.slice(0, 1), deps);
    deps.post = async () => {
      throw new Error("HTTP 503");
    };
    const got = await loadAdvisories(PKGS, deps);
    assert.equal(got.checked, false);
    assert.match(got.note ?? "", /503/);
    assert.equal(got.found.get("lodash@4.17.20")?.length, 2);
  });

  it("refuses an answer that is not the shape OSV documents", async () => {
    const deps = fakeDeps({ post: async () => '{"results": "no"}' });
    const got = await loadAdvisories(PKGS, deps);
    assert.equal(got.checked, false);
    const short = fakeDeps({ post: async () => JSON.stringify({ results: [{}] }) });
    assert.equal((await loadAdvisories(PKGS, short)).checked, false, "fewer answers than asked");
  });

  it("drops advisory ids that are not plain identifiers, and ignores a corrupt cache", async () => {
    const deps = fakeDeps({
      post: async () =>
        JSON.stringify({
          results: [{ vulns: [{ id: "GHSA-ok-1" }, { id: "bad id\n<script>" }] }, {}, {}],
        }),
      readCache: () => "{ not json",
    });
    const got = await loadAdvisories(PKGS, deps);
    assert.deepEqual(got.found.get("lodash@4.17.20"), ["GHSA-ok-1"]);
  });

  it("does nothing for an empty list", async () => {
    const deps = fakeDeps();
    const got = await loadAdvisories([], deps);
    assert.equal(deps.posts.length, 0);
    assert.equal(got.checked, true);
  });
});

function node(id: string, deps: string[] = [], dev = false): GraphNode {
  const at = id.lastIndexOf("@");
  return {
    id,
    name: id.slice(0, at),
    version: id.slice(at + 1),
    dev,
    deps,
    bins: [],
    hasInstallScript: false,
    platformOnly: false,
  };
}

describe("advisoriesPerDirect", () => {
  const graph: DepGraph = {
    nodes: new Map(
      [
        node("big@1.0.0", ["mid@1.0.0", "shared@1.0.0"]),
        node("mid@1.0.0", ["leaf@1.0.0"]),
        node("leaf@1.0.0"),
        node("shared@1.0.0"),
        node("tool@1.0.0", ["shared@1.0.0"], true),
      ].map((n) => [n.id, n]),
    ),
    direct: new Map([
      ["big", "big@1.0.0"],
      ["tool", "tool@1.0.0"],
    ]),
    cannotSee: [],
  };
  const found = new Map([
    ["leaf@1.0.0", ["A-1", "A-2"]],
    ["shared@1.0.0", ["A-3"]],
    ["tool@1.0.0", ["A-4"]],
  ]);

  it("counts each distinct advisory in a direct dependency's closure, itself included", () => {
    const rows = advisoriesPerDirect(graph, found);
    const big = rows.find((r) => r.name === "big");
    assert.deepEqual(big?.ids.sort(), ["A-1", "A-2", "A-3"]);
    assert.equal(big?.dev, false);
    const tool = rows.find((r) => r.name === "tool");
    assert.deepEqual(tool?.ids.sort(), ["A-3", "A-4"]);
    assert.equal(tool?.dev, true);
  });

  it("lists the dependencies with the most advisories first and leaves out clean ones", () => {
    const rows = advisoriesPerDirect(graph, new Map([["leaf@1.0.0", ["A-1"]]]));
    assert.deepEqual(
      rows.map((r) => r.name),
      ["big"],
    );
    assert.deepEqual(
      advisoriesPerDirect(graph, found).map((r) => r.name),
      ["big", "tool"],
    );
  });

  it("counts a shared advisory once for the whole project", () => {
    const rows = advisoriesPerDirect(graph, found);
    assert.equal(new Set(rows.flatMap((r) => r.ids)).size, 4);
  });
});
