import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { buildUpstreamReport, enforceFails } from "./upstream-report.js";
import type { UpstreamLookup } from "./upstream-sources.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function inProject(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kit-upstream-report-"));
  for (const [file, text] of Object.entries(files)) {
    const full = join(dir, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return body(dir).finally(() => rmTemp(dir));
}

const PROJECT = {
  "package.json": JSON.stringify({ dependencies: { convex: "^1.45.0", react: "^19.0.0" } }),
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: { "node_modules/convex": { version: "1.45.2" } },
  }),
};

function okLookup(latest: string, body = ""): () => Promise<UpstreamLookup> {
  return async () => ({
    status: "ok",
    npm: [
      { name: "convex", ok: true, latest },
      { name: "@convex-dev/eslint-plugin", ok: false, error: "x" },
    ],
    github: [
      {
        name: "convex/convex-js",
        ok: true,
        releases: body
          ? [
              {
                tag: `v${latest}`,
                version: latest,
                name: latest,
                body,
                url: "https://r",
                prerelease: false,
                publishedAt: "d",
              },
            ]
          : [],
      },
    ],
  });
}

describe("buildUpstreamReport", () => {
  it("reports one minor behind with the deprecation line from the notes", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: okLookup("1.46.0", "- Deprecated the `foo` option"),
      });
      assert.equal(report.status, "ok");
      assert.equal(report.rows.length, 1);
      const row = report.rows[0];
      assert.equal(row.id, "convex");
      assert.equal(row.package, "convex");
      assert.equal(row.manifest, "package.json");
      assert.equal(row.installed, "1.45.2");
      assert.equal(row.installedSource, "package-lock.json");
      assert.equal(row.latest, "1.46.0");
      assert.equal(row.bump, "minor");
      assert.equal(row.verdict, "upgrade recommended (deprecation)");
      assert.equal(row.notes[0].keyword, "deprecat");
      assert.equal(row.notesAvailable, true);
    }));

  it("says so when the service publishes no GitHub release notes", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, { lookup: okLookup("1.46.0") });
      assert.equal(report.rows[0].verdict, "upgrade available");
      assert.equal(report.rows[0].notesAvailable, false);
    }));
});

describe("buildUpstreamReport posture and edge cases", () => {
  it("is current when installed equals latest", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, { lookup: okLookup("1.45.2") });
      assert.equal(report.rows[0].verdict, "current");
    }));

  it("marks every row skipped and calls no fetch in air gap", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => ({ status: "skipped", reason: "air gap", npm: [], github: [] }),
      });
      assert.equal(report.status, "skipped");
      assert.equal(report.reason, "air gap");
      assert.equal(report.rows[0].verdict, "skipped");
    }));

  it("reports unknown, not current, when the registry cannot be reached", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => ({
          status: "unknown",
          npm: [{ name: "convex", ok: false, error: "fetch failed" }],
          github: [],
        }),
      });
      assert.equal(report.rows[0].verdict, "unknown");
      assert.match(report.rows[0].detail ?? "", /fetch failed/);
    }));

  it("lists a service declared only in .kit.toml as unknown, with the reason", () =>
    inProject({ ".kit.toml": '[services.stripe]\ncheck = "x"\n' }, async (dir) => {
      const report = await buildUpstreamReport(dir, { lookup: okLookup("1.0.0") });
      const row = report.rows.find((r) => r.id === "stripe");
      assert.equal(row?.verdict, "unknown");
      assert.match(row?.detail ?? "", /no package/);
    }));

  it("applies an [upstream] override from .kit.toml", () =>
    inProject(
      {
        "package.json": JSON.stringify({ dependencies: { "acme-sdk": "^2.0.0" } }),
        ".kit.toml": '[upstream.acme]\nnpm = ["acme-sdk"]\n',
      },
      async (dir) => {
        const report = await buildUpstreamReport(dir, {
          lookup: async () => ({
            status: "ok",
            npm: [{ name: "acme-sdk", ok: true, latest: "3.0.0" }],
            github: [],
          }),
        });
        assert.equal(report.rows[0].id, "acme");
        assert.equal(report.rows[0].verdict, "major, read notes");
      },
    ));

  it("throws a clear error for an invalid [upstream] table", () =>
    inProject({ ".kit.toml": '[upstream.acme]\nnpm = "acme-sdk"\n' }, async (dir) => {
      await assert.rejects(
        buildUpstreamReport(dir, { lookup: okLookup("1.0.0") }),
        /\[upstream\.acme\]/,
      );
    }));

  it("returns an empty report for a project that uses no cataloged service", () =>
    inProject(
      { "package.json": JSON.stringify({ dependencies: { lodash: "^4" } }) },
      async (dir) => {
        const report = await buildUpstreamReport(dir, { lookup: okLookup("1.0.0") });
        assert.deepEqual(report.rows, []);
        assert.equal(report.status, "ok");
      },
    ));
});

describe("enforceFails", () => {
  const base = { status: "ok" as const, skippedInputs: [] };
  const row = (verdict: string) => ({ verdict }) as never;

  it("fails on a major or a deprecation", () => {
    assert.equal(enforceFails({ ...base, rows: [row("major, read notes")] }), true);
    assert.equal(enforceFails({ ...base, rows: [row("upgrade recommended (deprecation)")] }), true);
  });

  it("passes on current, plain upgrades, unknown and skipped", () => {
    for (const v of [
      "current",
      "upgrade available",
      "upgrade available, read notes",
      "unknown",
      "skipped",
    ]) {
      assert.equal(enforceFails({ ...base, rows: [row(v)] }), false, v);
    }
  });
});

describe("terminal control characters in the report", () => {
  it("strips them from the detail text that comes from a failed fetch", () =>
    inProject(PROJECT, async (dir) => {
      const report = await buildUpstreamReport(dir, {
        lookup: async () => ({
          status: "unknown",
          npm: [{ name: "convex", ok: false, error: `bad\u001b[2Jnews` }],
          github: [],
        }),
      });
      assert.ok(!(report.rows[0].detail ?? "").includes("\u001b"));
    }));
});
