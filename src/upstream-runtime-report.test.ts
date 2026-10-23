import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { upstreamRowsFromReport } from "./check-upstream.js";
import { buildUpstreamReport, enforceFails } from "./upstream-report.js";
import type { UpstreamLookup } from "./upstream-sources.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function inProject(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kit-runtime-report-"));
  for (const [file, text] of Object.entries(files)) {
    const full = join(dir, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return body(dir).finally(() => rmTemp(dir));
}

const release = (tag: string, body: string) => ({
  tag,
  version: null,
  name: tag,
  body,
  url: "https://r",
  prerelease: false,
  publishedAt: "d",
});

const NODE_LOOKUP: UpstreamLookup = {
  status: "ok",
  npm: [],
  github: [
    {
      name: "nodejs/node",
      ok: true,
      releases: [
        release("v22.23.4", "This is a security release.\n* (CVE-2026-111497) brotli"),
        release("v22.23.3", "Bug fixes"),
      ],
    },
  ],
  tags: [],
};

const PROJECT = { ".nvmrc": "22\n", "package.json": "{}" };
const installed = (v: string | null) => async () => v;

describe("runtime rows in the upstream report", () => {
  it("flags a security release of the installed Node line", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => NODE_LOOKUP,
        readInstalled: installed("22.23.3"),
      });
      assert.equal(report.runtimes.length, 1);
      const row = report.runtimes[0];
      assert.equal(row.id, "node");
      assert.equal(row.installed, "22.23.3");
      assert.equal(row.declared, "22");
      assert.equal(row.latest, "22.23.4");
      assert.equal(row.verdict, "security release available");
      assert.ok(row.evidence.some((l) => l.includes("CVE-2026-111497")));
    }));

  it("is current on the newest patch", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => NODE_LOOKUP,
        readInstalled: installed("22.23.4"),
      });
      assert.equal(report.runtimes[0].verdict, "current");
    }));

  it("marks the row skipped in air gap and does not report current", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => ({
          status: "skipped",
          reason: "air gap",
          npm: [],
          github: [],
          tags: [],
        }),
        readInstalled: installed("22.23.3"),
      });
      assert.equal(report.runtimes[0].verdict, "skipped");
      assert.equal(report.status, "skipped");
      assert.equal(report.reason, "air gap");
    }));
});

describe("runtime rows when the lookup fails or the install differs", () => {
  it("reports unknown with the error when the releases cannot be read", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => ({
          status: "unknown",
          npm: [],
          github: [{ name: "nodejs/node", ok: false, error: "gh: not logged in" }],
          tags: [],
        }),
        readInstalled: installed("22.23.3"),
      });
      assert.equal(report.runtimes[0].verdict, "unknown");
      assert.match(report.runtimes[0].detail ?? "", /not logged in/);
    }));

  it("notes when the declared major differs from the installed one", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => NODE_LOOKUP,
        readInstalled: installed("24.1.0"),
      });
      assert.match(report.runtimes[0].detail ?? "", /declared 22.*installed 24/);
    }));

  it("reports a runtime that is not installed as unknown", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => NODE_LOOKUP,
        readInstalled: installed(null),
      });
      assert.equal(report.runtimes[0].verdict, "unknown");
      assert.match(report.runtimes[0].detail ?? "", /not found/);
    }));

  it("skips the runtime check entirely when asked", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => NODE_LOOKUP,
        runtimes: false,
      });
      assert.deepEqual(report.runtimes, []);
    }));
});

describe("runtime verdicts in enforce and in kit check", () => {
  const base = { status: "ok" as const, rows: [], skippedInputs: [] };
  const rt = (verdict: string) =>
    ({
      id: "node",
      label: "Node.js",
      installed: "22.0.0",
      declared: null,
      declaredFrom: null,
      latest: "22.1.0",
      verdict,
      evidence: ["x"],
    }) as never;

  it("--enforce fails on a security release and not on a plain patch", () => {
    assert.equal(enforceFails({ ...base, runtimes: [rt("security release available")] }), true);
    assert.equal(enforceFails({ ...base, runtimes: [rt("patch available")] }), false);
    assert.equal(enforceFails({ ...base, runtimes: [rt("current")] }), false);
  });

  it("kit check rows warn on a security release, pass when current, and never fail", () => {
    const rows = upstreamRowsFromReport({
      ...base,
      runtimes: [rt("security release available"), rt("current"), rt("unknown")],
    });
    assert.deepEqual(
      rows.map((r) => r.status),
      ["warn", "pass", "warn"],
    );
    assert.equal(rows[2].didNotRun, true);
    assert.match(rows[0].name, /Node\.js/);
    assert.match(rows[0].detail, /22\.0\.0 -> 22\.1\.0/);
  });
});
