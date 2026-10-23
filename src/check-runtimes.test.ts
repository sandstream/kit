import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { checkRuntimes } from "./check-runtimes.js";
import type { UpstreamLookup, UpstreamService } from "./upstream-sources.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");

const rel = (tag: string, body: string) => ({
  tag,
  version: null,
  name: tag,
  body,
  url: "https://r",
  prerelease: false,
  publishedAt: "d",
});

const SCHEDULE = JSON.stringify({
  v22: { end: "2027-04-30" },
  v24: { end: "2028-04-30" },
  v25: { end: "2026-06-01" },
});

function nodeLookup(over: Partial<UpstreamLookup> = {}): UpstreamLookup {
  return {
    status: "ok",
    npm: [],
    github: [
      {
        name: "nodejs/node",
        ok: true,
        releases: [
          rel("v24.22.1", "This is a security release.\n* (CVE-2026-111497) brotli"),
          rel("v24.22.0", "Bug fixes"),
          rel("v22.23.4", "This is a security release."),
          rel("v22.23.3", "Bug fixes"),
        ],
      },
    ],
    tags: [],
    files: [{ name: "nodejs/Release:schedule.json", ok: true, text: SCHEDULE }],
    ...over,
  };
}

const NOTHING_CACHED: UpstreamLookup = {
  status: "unknown",
  npm: [],
  github: [
    {
      name: "nodejs/node",
      ok: false,
      error: "not in the cache or older than its limit (run kit upstream check)",
    },
  ],
  tags: [],
  files: [
    {
      name: "nodejs/Release:schedule.json",
      ok: false,
      error: "not in the cache or older than its limit",
    },
  ],
};

function inProject(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kit-check-runtimes-"));
  for (const [f, text] of Object.entries(files)) {
    const full = join(dir, f);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return body(dir).finally(() => rmTemp(dir));
}

const NODE_PROJECT = { "package.json": "{}", ".nvmrc": "24\n" };
const installed = (v: string | null) => async () => v;

describe("checkRuntimes", () => {
  it("fails a Node line that has a security release the installed version lacks (a pinned major hid a patched line)", () =>
    inProject(NODE_PROJECT, async (dir) => {
      const rows = await checkRuntimes(dir, {
        readInstalled: installed("24.13.1"),
        lookup: async () => nodeLookup(),
        now: () => NOW,
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, "runtime: node");
      assert.equal(rows[0].status, "fail");
      assert.equal(rows[0].severity, "high");
      assert.match(rows[0].detail, /24\.13\.1/);
      assert.match(rows[0].detail, /24\.22\.1/);
      assert.match(rows[0].detail, /CVE-2026-111497/);
      assert.match(rows[0].suggestion ?? "", /mise install node@24\.22\.1/);
    }));

  it("fails an end-of-life line, and does so without any release data in the cache", () =>
    inProject(NODE_PROJECT, async (dir) => {
      const lookup = async () => ({
        ...NOTHING_CACHED,
        status: "ok" as const,
        files: nodeLookup().files,
      });
      const rows = await checkRuntimes(dir, {
        readInstalled: installed("25.8.0"),
        lookup,
        now: () => NOW,
      });
      assert.equal(rows[0].status, "fail");
      assert.match(rows[0].detail, /end of life on 2026-06-01/);
    }));

  it("passes the newest patch of a supported line and says until when it is supported", () =>
    inProject(NODE_PROJECT, async (dir) => {
      const rows = await checkRuntimes(dir, {
        readInstalled: installed("24.22.1"),
        lookup: async () => nodeLookup(),
        now: () => NOW,
      });
      assert.equal(rows[0].status, "pass");
      assert.match(rows[0].detail, /24\.22\.1/);
    }));

  it("warns, never fails, on a patch without a security note", () =>
    inProject(NODE_PROJECT, async (dir) => {
      const rows = await checkRuntimes(dir, {
        readInstalled: installed("24.22.0"),
        lookup: async () => nodeLookup(),
        now: () => NOW,
      });
      assert.equal(rows[0].status, "fail", "24.22.1 is a security release, so 24.22.0 fails");
      const plain = nodeLookup({
        github: [
          {
            name: "nodejs/node",
            ok: true,
            releases: [rel("v24.22.1", "Bug fixes"), rel("v24.22.0", "x")],
          },
        ],
      });
      const rows2 = await checkRuntimes(dir, {
        readInstalled: installed("24.22.0"),
        lookup: async () => plain,
        now: () => NOW,
      });
      assert.equal(rows2[0].status, "warn");
      assert.match(rows2[0].suggestion ?? "", /mise install node@24\.22\.1/);
    }));

  it("is unverified, a warning and never green, when the cache holds nothing current", () =>
    inProject(NODE_PROJECT, async (dir) => {
      const rows = await checkRuntimes(dir, {
        readInstalled: installed("24.13.1"),
        lookup: async () => NOTHING_CACHED,
        now: () => NOW,
      });
      assert.equal(rows[0].status, "warn");
      assert.match(rows[0].detail, /unverified/);
      assert.match(rows[0].suggestion ?? "", /kit upstream check/);
    }));

  it("reads the cache only by default, and fetches only with online", () =>
    inProject(NODE_PROJECT, async (dir) => {
      const seen: boolean[] = [];
      const lookup = async (_s: UpstreamService, opts: { cacheOnly: boolean }) => {
        seen.push(opts.cacheOnly);
        return nodeLookup();
      };
      await checkRuntimes(dir, { readInstalled: installed("24.22.1"), lookup, now: () => NOW });
      await checkRuntimes(dir, {
        readInstalled: installed("24.22.1"),
        lookup,
        now: () => NOW,
        online: true,
      });
      assert.deepEqual(seen, [true, false]);
    }));

  it("is unverified when the runtime is not installed", () =>
    inProject(NODE_PROJECT, async (dir) => {
      const rows = await checkRuntimes(dir, {
        readInstalled: installed(null),
        lookup: async () => nodeLookup(),
        now: () => NOW,
      });
      assert.equal(rows[0].status, "warn");
      assert.match(rows[0].detail, /not found/);
    }));

  it("reports nothing for a project that uses no Node, PHP or Python", () =>
    inProject({ "README.md": "x" }, async (dir) => {
      assert.deepEqual(
        await checkRuntimes(dir, {
          readInstalled: installed("1.0.0"),
          lookup: async () => nodeLookup(),
          now: () => NOW,
        }),
        [],
      );
    }));
});
