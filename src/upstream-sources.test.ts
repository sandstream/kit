import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createGhFileFetcher,
  createGhReleaseFetcher,
  createGhTagFetcher,
  createNpmLatestFetcher,
  lookupUpstream,
  parseReleases,
  upstreamPosture,
  type UpstreamFetcher,
} from "./upstream-sources.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const SERVICE = { npm: ["convex", "@convex-dev/eslint-plugin"], github: ["convex/convex-js"] };

function fakeFetcher(calls: string[] = []): UpstreamFetcher {
  return {
    async npmLatest(name) {
      calls.push(`npm:${name}`);
      return name === "convex" ? "1.46.0" : "5.0.0";
    },
    async githubTags() {
      return [];
    },
    async githubFile() {
      return "{}";
    },
    async githubReleases(repo) {
      calls.push(`gh:${repo}`);
      return [
        {
          tag: "v1.46.0",
          version: "1.46.0",
          name: "1.46.0",
          body: "deprecated foo",
          url: "u",
          prerelease: false,
          publishedAt: "2026-10-01T00:00:00Z",
        },
      ];
    },
  };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "kit-upstream-cache-"));
});
afterEach(() => rmTemp(cacheDir));

const allowed = { allowed: true } as const;

describe("lookupUpstream", () => {
  it("returns latest versions and release notes for every source", async () => {
    const got = await lookupUpstream(SERVICE, {
      fetcher: fakeFetcher(),
      posture: allowed,
      cacheDir,
    });
    assert.equal(got.status, "ok");
    assert.deepEqual(
      got.npm.map((n) => [n.name, n.ok && n.latest]),
      [
        ["convex", "1.46.0"],
        ["@convex-dev/eslint-plugin", "5.0.0"],
      ],
    );
    assert.equal(got.github[0].ok && got.github[0].releases[0].version, "1.46.0");
  });

  it("skips every fetch in air gap and says so", async () => {
    const calls: string[] = [];
    const got = await lookupUpstream(SERVICE, {
      fetcher: fakeFetcher(calls),
      posture: { allowed: false, reason: "air gap" },
      cacheDir,
    });
    assert.equal(got.status, "skipped");
    assert.equal(got.reason, "air gap");
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(cacheDir), []);
  });

  it("skips every fetch in read-only mode", async () => {
    const calls: string[] = [];
    const got = await lookupUpstream(SERVICE, {
      fetcher: fakeFetcher(calls),
      posture: { allowed: false, reason: "read-only" },
      cacheDir,
    });
    assert.equal(got.status, "skipped");
    assert.equal(got.reason, "read-only");
    assert.deepEqual(calls, []);
  });

  it("reports unknown, never ok, when every source fails", async () => {
    const failing: UpstreamFetcher = {
      async npmLatest() {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      },
      async githubReleases() {
        throw new Error("gh: not logged in");
      },
      async githubTags() {
        throw new Error("gh: not logged in");
      },
      async githubFile() {
        return "{}";
      },
    };
    const got = await lookupUpstream(SERVICE, { fetcher: failing, posture: allowed, cacheDir });
    assert.equal(got.status, "unknown");
    assert.match(String(!got.npm[0].ok && got.npm[0].error), /ENOTFOUND/);
    assert.match(String(!got.github[0].ok && got.github[0].error), /not logged in/);
  });

  it("keeps the sources that answered when one fails", async () => {
    const half: UpstreamFetcher = {
      ...fakeFetcher(),
      async githubReleases() {
        throw new Error("rate limited");
      },
    };
    const got = await lookupUpstream(SERVICE, { fetcher: half, posture: allowed, cacheDir });
    assert.equal(got.status, "ok");
    assert.equal(got.github[0].ok, false);
    assert.equal(got.npm[0].ok, true);
  });
});

describe("lookupUpstream cache and failures", () => {
  it("answers from the cache inside the TTL and fetches again after it", async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    const deps = {
      fetcher: fakeFetcher(calls),
      posture: allowed,
      cacheDir,
      ttlMs: 60_000,
      now: () => now,
    };
    await lookupUpstream(SERVICE, deps);
    const first = calls.length;
    assert.equal(first, 3);
    now += 59_000;
    await lookupUpstream(SERVICE, deps);
    assert.equal(calls.length, first);
    now += 2_000;
    await lookupUpstream(SERVICE, deps);
    assert.equal(calls.length, first * 2);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const flaky: UpstreamFetcher = {
      async npmLatest() {
        if (fail) throw new Error("timeout");
        return "1.0.0";
      },
      async githubReleases() {
        return [];
      },
      async githubTags() {
        return [];
      },
      async githubFile() {
        return "{}";
      },
    };
    const deps = { fetcher: flaky, posture: allowed, cacheDir };
    const svc = { npm: ["convex"], github: [] };
    assert.equal((await lookupUpstream(svc, deps)).status, "unknown");
    fail = false;
    const got = await lookupUpstream(svc, deps);
    assert.equal(got.status, "ok");
    assert.equal(got.npm[0].ok && got.npm[0].latest, "1.0.0");
  });

  it("ignores a corrupt cache file", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(cacheDir, "upstream-cache.json"), "{ nope");
    const got = await lookupUpstream(SERVICE, {
      fetcher: fakeFetcher(),
      posture: allowed,
      cacheDir,
    });
    assert.equal(got.status, "ok");
  });
});

describe("upstreamPosture", () => {
  const saved = { air: process.env.KIT_AIRGAP, ro: process.env.KIT_READ_ONLY };
  afterEach(() => {
    for (const [key, value] of [
      ["KIT_AIRGAP", saved.air],
      ["KIT_READ_ONLY", saved.ro],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("blocks on KIT_AIRGAP", async () => {
    delete process.env.KIT_READ_ONLY;
    process.env.KIT_AIRGAP = "1";
    assert.deepEqual(await upstreamPosture(), { allowed: false, reason: "air gap" });
  });

  it("blocks on KIT_READ_ONLY", async () => {
    delete process.env.KIT_AIRGAP;
    process.env.KIT_READ_ONLY = "1";
    assert.deepEqual(await upstreamPosture(), { allowed: false, reason: "read-only" });
  });
});

describe("createNpmLatestFetcher", () => {
  it("asks the registry for the abbreviated document and reads dist-tags.latest", async () => {
    const seen: { url: string; accept: string | null }[] = [];
    const fetcher = createNpmLatestFetcher({
      registry: "https://registry.example",
      fetchFn: async (url, init) => {
        seen.push({ url: String(url), accept: new Headers(init?.headers).get("accept") });
        return new Response(JSON.stringify({ "dist-tags": { latest: "1.46.0" } }), { status: 200 });
      },
    });
    assert.equal(await fetcher("@convex-dev/eslint-plugin"), "1.46.0");
    assert.equal(seen[0].url, "https://registry.example/@convex-dev%2Feslint-plugin");
    assert.match(seen[0].accept ?? "", /vnd\.npm\.install-v1\+json/);
  });

  it("encodes every slash of a package name", async () => {
    let url = "";
    const fetcher = createNpmLatestFetcher({
      registry: "https://registry.example",
      fetchFn: async (u) => {
        url = String(u);
        return new Response(JSON.stringify({ "dist-tags": { latest: "1.0.0" } }), { status: 200 });
      },
    });
    await fetcher("a/b/c");
    assert.equal(url, "https://registry.example/a%2Fb%2Fc");
  });

  it("rejects a non-200 answer", async () => {
    const fetcher = createNpmLatestFetcher({
      fetchFn: async () => new Response("nope", { status: 404 }),
    });
    await assert.rejects(fetcher("missing"), /404/);
  });

  it("rejects a document with no usable latest tag", async () => {
    const fetcher = createNpmLatestFetcher({
      fetchFn: async () =>
        new Response(JSON.stringify({ "dist-tags": { latest: "banana" } }), { status: 200 }),
    });
    await assert.rejects(fetcher("x"), /latest/);
  });
});

describe("createGhReleaseFetcher", () => {
  it("calls gh api for the releases and parses them", async () => {
    let args: string[] = [];
    const fetcher = createGhReleaseFetcher(async (_cmd, a) => {
      args = a;
      return JSON.stringify([
        {
          tag_name: "v2.0.0",
          name: "2.0.0",
          body: "removed x",
          html_url: "https://u",
          prerelease: false,
          draft: false,
          published_at: "2026-10-02T00:00:00Z",
        },
      ]);
    });
    const releases = await fetcher("stripe/stripe-node");
    assert.deepEqual(args, ["api", "repos/stripe/stripe-node/releases?per_page=10"]);
    assert.equal(releases[0].version, "2.0.0");
  });

  it("rejects when gh fails", async () => {
    const fetcher = createGhReleaseFetcher(async () => {
      throw new Error("gh: command not found");
    });
    await assert.rejects(fetcher("o/r"), /command not found/);
  });

  it("rejects output that is not JSON", async () => {
    const fetcher = createGhReleaseFetcher(async () => "<html>");
    await assert.rejects(fetcher("o/r"), /JSON/);
  });
});

describe("parseReleases", () => {
  it("drops drafts, keeps prereleases flagged, and leaves unparseable tags with a null version", () => {
    const out = parseReleases([
      { tag_name: "v1.0.0", draft: true },
      {
        tag_name: "v1.1.0-rc.1",
        prerelease: true,
        name: "rc",
        body: "b",
        html_url: "u",
        published_at: "d",
      },
      { tag_name: "nightly", name: "n", body: "", html_url: "u", published_at: "d" },
    ]);
    assert.deepEqual(
      out.map((r) => [r.tag, r.version, r.prerelease]),
      [
        ["v1.1.0-rc.1", "1.1.0-rc.1", true],
        ["nightly", null, false],
      ],
    );
  });

  it("caps a very long release body", () => {
    const out = parseReleases([{ tag_name: "v1.0.0", body: "x".repeat(100_000) }]);
    assert.ok(out[0].body.length <= 20_000);
  });

  it("returns nothing for a payload that is not a list", () => {
    assert.deepEqual(parseReleases({ message: "Not Found" }), []);
  });
});

describe("terminal control characters in remote text", () => {
  const ESC = String.fromCharCode(27);

  it("strips them from every release field and keeps line breaks in the body", () => {
    const out = parseReleases([
      {
        tag_name: `v1.0.0${ESC}[2J`,
        name: `name${ESC}]0;evil\u0007`,
        body: `- Deprecated ${ESC}[31mred\n- second\u0085line`,
        html_url: `https://u${ESC}[0m`,
      },
    ]);
    const text = JSON.stringify(out[0]);
    assert.ok(!text.includes("\\u001b") && !text.includes("\\u0007") && !text.includes("\\u0085"));
    assert.equal(out[0].body.split("\n").length, 2);
    assert.equal(out[0].tag, "v1.0.0[2J");
  });
});

describe("GitHub tags and the release window", () => {
  it("createGhTagFetcher lists tag names through gh api", async () => {
    let args: string[] = [];
    const fetcher = createGhTagFetcher(async (_cmd, a) => {
      args = a;
      return JSON.stringify([{ name: "v3.15.1" }, { name: "v3.15.0" }, { nope: 1 }]);
    });
    assert.deepEqual(await fetcher("python/cpython"), ["v3.15.1", "v3.15.0"]);
    assert.deepEqual(args, ["api", "repos/python/cpython/tags?per_page=100"]);
  });

  it("createGhTagFetcher rejects output that is not JSON", async () => {
    await assert.rejects(createGhTagFetcher(async () => "<html>")("o/r"), /JSON/);
  });

  it("createGhReleaseFetcher asks for the wider window when one is given", async () => {
    let args: string[] = [];
    const fetcher = createGhReleaseFetcher(async (_cmd, a) => {
      args = a;
      return "[]";
    });
    await fetcher("nodejs/node", 30);
    assert.deepEqual(args, ["api", "repos/nodejs/node/releases?per_page=30"]);
  });

  it("lookupUpstream returns tags and passes the window to the fetcher", async () => {
    const seen: (number | undefined)[] = [];
    const fetcher: UpstreamFetcher = {
      ...fakeFetcher(),
      async githubReleases(_repo, perPage) {
        seen.push(perPage);
        return [];
      },
      async githubTags() {
        return ["v3.15.1"];
      },
    };
    const got = await lookupUpstream(
      { npm: [], github: ["nodejs/node"], githubTags: ["python/cpython"], releaseWindow: 30 },
      { fetcher, posture: allowed, cacheDir },
    );
    assert.deepEqual(seen, [30]);
    assert.equal(got.status, "ok");
    assert.deepEqual(got.tags[0].ok && got.tags[0].tags, ["v3.15.1"]);
  });

  it("does not mix a wide release window with the default one in the cache", async () => {
    const seen: (number | undefined)[] = [];
    const fetcher: UpstreamFetcher = {
      ...fakeFetcher(),
      async githubReleases(_repo, perPage) {
        seen.push(perPage);
        return [];
      },
    };
    const deps = { fetcher, posture: allowed, cacheDir };
    await lookupUpstream({ npm: [], github: ["o/r"] }, deps);
    await lookupUpstream({ npm: [], github: ["o/r"], releaseWindow: 30 }, deps);
    assert.deepEqual(seen, [undefined, 30]);
  });

  it("strips terminal control characters from tag names", async () => {
    const fetcher = createGhTagFetcher(async () =>
      JSON.stringify([{ name: `v1.0.0${String.fromCharCode(27)}[2J` }]),
    );
    assert.deepEqual(await fetcher("o/r"), ["v1.0.0[2J"]);
  });
});

describe("GitHub files and the cache-only read", () => {
  const SCHEDULE = JSON.stringify({ v22: { end: "2027-04-30" } });

  it("createGhFileFetcher reads one file as raw text through gh api", async () => {
    let args: string[] = [];
    const fetcher = createGhFileFetcher(async (_cmd, a) => {
      args = a;
      return SCHEDULE;
    });
    assert.equal(await fetcher("nodejs/Release", "schedule.json"), SCHEDULE);
    assert.deepEqual(args, [
      "api",
      "-H",
      "Accept: application/vnd.github.raw+json",
      "repos/nodejs/Release/contents/schedule.json",
    ]);
  });

  it("createGhFileFetcher refuses a path that could leave the repository or add an option", async () => {
    const fetcher = createGhFileFetcher(async () => "x");
    for (const bad of ["../x", "/etc/passwd", "-H", "a b", "a?b=1"]) {
      await assert.rejects(fetcher("o/r", bad), /path/, bad);
    }
  });

  it("lookupUpstream returns the files it was asked for", async () => {
    const fetcher: UpstreamFetcher = {
      ...fakeFetcher(),
      async githubFile() {
        return SCHEDULE;
      },
    };
    const got = await lookupUpstream(
      { npm: [], github: [], githubFiles: [{ repo: "nodejs/Release", path: "schedule.json" }] },
      { fetcher, posture: allowed, cacheDir },
    );
    assert.equal(got.status, "ok");
    assert.equal(got.files[0].ok && got.files[0].text, SCHEDULE);
  });
});

describe("the cache-only read", () => {
  const SCHEDULE = JSON.stringify({ v22: { end: "2027-04-30" } });

  it("cacheOnly never calls the fetcher and says where the answer is missing", async () => {
    const calls: string[] = [];
    const fetcher = {
      ...fakeFetcher(calls),
      async githubFile() {
        calls.push("file");
        return SCHEDULE;
      },
    };
    const got = await lookupUpstream(
      {
        npm: ["convex"],
        github: ["o/r"],
        githubFiles: [{ repo: "nodejs/Release", path: "schedule.json" }],
      },
      { fetcher, posture: allowed, cacheDir, cacheOnly: true },
    );
    assert.deepEqual(calls, []);
    assert.equal(got.status, "unknown");
    assert.match(String(!got.npm[0].ok && got.npm[0].error), /not in the cache/);
  });

  it("cacheOnly serves what a fetching run stored, and drops it once it is older than the limit", async () => {
    let now = 1_000_000;
    const base = { fetcher: fakeFetcher(), posture: allowed, cacheDir, now: () => now };
    const svc = { npm: ["convex"], github: [] };
    await lookupUpstream(svc, { ...base, ttlMs: 60_000 });
    now += 30_000;
    const fresh = await lookupUpstream(svc, { ...base, ttlMs: 60_000, cacheOnly: true });
    assert.equal(fresh.npm[0].ok && fresh.npm[0].latest, "1.46.0");
    now += 60_000;
    const stale = await lookupUpstream(svc, { ...base, ttlMs: 60_000, cacheOnly: true });
    assert.equal(stale.npm[0].ok, false);
  });

  it("cacheOnly writes nothing", async () => {
    await lookupUpstream(
      { npm: ["convex"], github: [] },
      { fetcher: fakeFetcher(), posture: allowed, cacheDir, cacheOnly: true },
    );
    assert.deepEqual(readdirSync(cacheDir), []);
  });
});
