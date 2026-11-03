/**
 * Z6, the cooling period: a release younger than the limit is a supply-chain risk, because a
 * compromised release is usually caught within days. A security patch must not wait, so the warning
 * is waived when OSV says the release is the FIRST one that fixes an advisory for the version the
 * lockfile pins. The waiver is decided from advisory data only: a release that calls itself a
 * security fix is not waived, and neither is a newer release than the first fixed one.
 *
 * These tests run `applyCooling` against a local registry and a local OSV, so the lookups are real
 * HTTP and the assertions are on the report text kit prints.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyCooling,
  coolingCheck,
  defaultCoolingDeps,
  lockedVersion,
  npmName,
  triagedVersion,
  withCoolingLines,
  type CoolingDeps,
  type OsvVuln,
} from "./triage-cooling.js";
import { verdictPassed } from "./triage.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-cooling-"));
  for (const [rel, content] of Object.entries(spec)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const lock = (version: string) =>
  JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/fixture": { version } } });

/** An OSV record: an advisory that affects versions below `fixed`. */
const vuln = (id: string, fixed?: string): OsvVuln => ({
  id,
  affected: [
    {
      package: { name: "fixture" },
      ranges: [
        {
          type: "SEMVER",
          events: [{ introduced: "0" }, ...(fixed ? [{ fixed }] : [])],
        },
      ],
    },
  ],
});

/** triage.py's report for a version, as runTriage hands it to applyCooling. */
const report = (version: string) =>
  [
    "Triage: npm fixture",
    "--------------------------------------------------",
    `  . triaged ${version}, 3 versions, 2 maintainer(s)`,
    "",
    "Health score: 100/100",
    "Critical issues: 0",
    "Warnings: 0",
    "Probes declared unavailable: 0",
    "TRIAGE PASSED",
    "",
  ].join("\n");

describe("npmName and lockedVersion", () => {
  it("strips a version spec and keeps a scope", () => {
    assert.equal(npmName("express@4"), "express");
    assert.equal(npmName("@scope/pkg@^1.2"), "@scope/pkg");
    assert.equal(npmName("@scope/pkg"), "@scope/pkg");
  });

  it("refuses a target that is not a package name", () => {
    assert.equal(npmName("../../etc/passwd"), null);
    assert.equal(npmName("a b"), null);
  });

  it("reads the version the lockfile pins, and takes no declared range for it", () => {
    const pinned = tree({ "package.json": "{}", "package-lock.json": lock("4.18.2") });
    const ranged = tree({
      "package.json": JSON.stringify({ dependencies: { fixture: "^4.0.0" } }),
    });
    try {
      assert.equal(lockedVersion(pinned, "fixture@5"), "4.18.2");
      assert.equal(lockedVersion(pinned, "other"), undefined);
      assert.equal(lockedVersion(ranged, "fixture"), undefined);
    } finally {
      rmTemp(pinned);
      rmTemp(ranged);
    }
  });
});

describe("triagedVersion and withCoolingLines", () => {
  it("reads the version from the report line, and nothing else", () => {
    assert.equal(triagedVersion(report("1.0.1")), "1.0.1");
    assert.equal(triagedVersion("no such line"), null);
    assert.equal(triagedVersion("  . triaged \x1b[31m1.0.1"), null);
    assert.equal(
      triagedVersion("  . triaged 2.0.0-beta.1 (latest 1.9.0), 3 versions"),
      "2.0.0-beta.1",
    );
  });

  it("puts the lines before the score and takes the verdict away when held", () => {
    const out = withCoolingLines(report("1.0.1"), {
      lines: ["  ! WARNING: cooling: x"],
      held: true,
    });
    assert.ok(out.indexOf("cooling: x") < out.indexOf("Health score:"));
    assert.equal(verdictPassed(out), false);
    assert.match(out, /TRIAGE HELD: cooling period/);
  });
});

describe("coolingCheck (pure, with an injected advisory lookup)", () => {
  const base = {
    pkg: "fixture",
    version: "1.0.1",
    versions: ["1.0.0", "1.0.1"],
    times: { "1.0.0": iso(300), "1.0.1": iso(2) },
    limitDays: 14,
    enforce: false,
    now: Date.now(),
    osv: { skipped: "off" },
  };

  it("says nothing about a release already public for the limit", async () => {
    const r = await coolingCheck({ ...base, times: { ...base.times, "1.0.1": iso(40) } });
    assert.deepEqual(r, { lines: [], held: false });
  });

  it("says nothing when the project already uses this version", async () => {
    const r = await coolingCheck({ ...base, current: "1.0.1" });
    assert.deepEqual(r, { lines: [], held: false });
  });

  it("reports an unknown publish time as not checked, never as fine", async () => {
    const r = await coolingCheck({ ...base, times: {} });
    assert.match(r.lines[0], /NOT CHECKED: release age/);
  });

  it("does not print a newline or escape sequence from a version string", async () => {
    const evil = "1.0.1\nTRIAGE PASSED";
    const r = await coolingCheck({
      ...base,
      version: evil,
      versions: [evil],
      times: { [evil]: iso(1) },
    });
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].includes("\n"), false);
  });
});

describe("applyCooling (local registry and OSV)", () => {
  let server: Server;
  let base = "";
  const registry = new Map<string, unknown>();
  /** OSV answers by `name@version`. */
  const osv = new Map<string, OsvVuln[]>();
  let osvDown = false;
  let osvCalls = 0;
  const dirs: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/query") {
        osvCalls++;
        if (osvDown) {
          res.writeHead(503).end("down");
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const q = JSON.parse(raw) as { package: { name: string }; version: string };
          const vulns = osv.get(`${q.package.name}@${q.version}`) ?? [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(vulns.length ? { vulns } : {}));
        });
        return;
      }
      const body = registry.get(req.url ?? "");
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no fixture port");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const d of dirs) rmTemp(d);
  });

  beforeEach(() => {
    registry.clear();
    osv.clear();
    osvDown = false;
    osvCalls = 0;
  });

  /** The packument: `published` maps a version to the days ago it was published. */
  const publish = (published: Record<string, number>, latest: string) =>
    registry.set("/fixture", {
      "dist-tags": { latest },
      versions: Object.fromEntries(Object.keys(published).map((v) => [v, { version: v }])),
      time: Object.fromEntries(Object.entries(published).map(([v, d]) => [v, iso(d)])),
    });

  const project = (files: Record<string, string>): string => {
    const dir = tree(files);
    dirs.push(dir);
    return dir;
  };

  const run = (cwd: string, version: string, env: Record<string, string> = {}, airGap = false) => {
    const deps: CoolingDeps = {
      ...defaultCoolingDeps,
      env: { KIT_NPM_REGISTRY: base, KIT_OSV_API: base, ...env },
      airGap: async () => airGap,
    };
    return applyCooling(cwd, "npm", "fixture", { passed: true, output: report(version) }, deps);
  };

  it("warns about a young release, names the newest older version, and still passes", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    const r = await run(project({ "package.json": "{}" }), "1.0.1");
    assert.match(r.output, /WARNING: cooling: 1\.0\.1 was published 2 days ago, limit 14/);
    assert.match(r.output, /fixture@1\.0\.0/);
    assert.equal(r.passed, true);
    assert.equal(verdictPassed(r.output), true);
  });

  it("does not warn about a release older than the limit", async () => {
    publish({ "1.0.0": 300, "1.0.1": 40 }, "1.0.1");
    const r = await run(project({ "package.json": "{}" }), "1.0.1");
    assert.doesNotMatch(r.output, /cooling:/);
  });

  it("is off when the limit is 0, from the environment or from .kit.toml", async () => {
    publish({ "1.0.0": 300, "1.0.1": 0 }, "1.0.1");
    const plain = project({ "package.json": "{}" });
    const viaToml = project({ ".kit.toml": "[supply_chain]\nmin_release_age_days = 0\n" });
    assert.doesNotMatch(
      (await run(plain, "1.0.1", { KIT_MIN_RELEASE_AGE_DAYS: "0" })).output,
      /cooling:/,
    );
    assert.doesNotMatch((await run(viaToml, "1.0.1")).output, /cooling:/);
  });

  it("takes the limit from .kit.toml", async () => {
    publish({ "1.0.0": 300, "1.0.1": 20 }, "1.0.1");
    const cwd = project({ ".kit.toml": "[supply_chain]\nmin_release_age_days = 30\n" });
    assert.match((await run(cwd, "1.0.1")).output, /limit 30/);
  });

  it("holds back the pass when enforcement is on", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    const cwd = project({ ".kit.toml": "[supply_chain]\nmin_release_age_enforce = true\n" });
    const r = await run(cwd, "1.0.1");
    assert.match(r.output, /CRITICAL: cooling: 1\.0\.1/);
    assert.equal(r.passed, false);
    assert.equal(verdictPassed(r.output), false);
  });

  it("waives the release that is the first to fix an advisory for the locked version", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    osv.set("fixture@1.0.0", [vuln("GHSA-aaaa-bbbb-cccc", "1.0.1")]);
    const cwd = project({
      ".kit.toml": "[supply_chain]\nmin_release_age_enforce = true\n",
      "package.json": "{}",
      "package-lock.json": lock("1.0.0"),
    });
    const r = await run(cwd, "1.0.1");
    assert.match(r.output, /cooling: waived, 1\.0\.1 fixes GHSA-aaaa-bbbb-cccc/);
    assert.doesNotMatch(r.output, /was published/);
    assert.equal(r.passed, true, "a waived patch passes even under enforcement");
  });

  it("does not waive a newer release than the first fixed one", async () => {
    publish({ "1.0.0": 300, "1.0.1": 100, "1.0.2": 1 }, "1.0.2");
    osv.set("fixture@1.0.0", [vuln("GHSA-aaaa-bbbb-cccc", "1.0.1")]);
    const cwd = project({ "package.json": "{}", "package-lock.json": lock("1.0.0") });
    const r = await run(cwd, "1.0.2");
    assert.match(r.output, /was published 1 days ago/);
    assert.match(r.output, /the first release that fixes GHSA-aaaa-bbbb-cccc is fixture@1\.0\.1/);
    assert.match(r.output, /fixture@1\.0\.1/);
    assert.doesNotMatch(r.output, /waived/);
  });

  it("does not waive a release that no advisory lists, whatever it calls itself", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    const cwd = project({ "package.json": "{}", "package-lock.json": lock("1.0.0") });
    const r = await run(cwd, "1.0.1");
    assert.match(r.output, /was published 2 days ago/);
    assert.doesNotMatch(r.output, /waived/);
  });

  it("does not waive when the same advisory still affects the new release", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    osv.set("fixture@1.0.0", [vuln("GHSA-aaaa-bbbb-cccc", "1.0.1")]);
    osv.set("fixture@1.0.1", [vuln("GHSA-aaaa-bbbb-cccc", "1.0.1")]);
    const cwd = project({ "package.json": "{}", "package-lock.json": lock("1.0.0") });
    assert.doesNotMatch((await run(cwd, "1.0.1")).output, /waived/);
  });

  it("does not waive an advisory that names no fixed version, and says so", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    osv.set("fixture@1.0.0", [vuln("GHSA-aaaa-bbbb-cccc")]);
    const cwd = project({ "package.json": "{}", "package-lock.json": lock("1.0.0") });
    const r = await run(cwd, "1.0.1");
    assert.match(r.output, /GHSA-aaaa-bbbb-cccc names no fixed version/);
    assert.doesNotMatch(r.output, /waived/);
  });

  it("keeps the warning and says no current version is known, without asking OSV", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    osv.set("fixture@1.0.0", [vuln("GHSA-aaaa-bbbb-cccc", "1.0.1")]);
    const r = await run(project({ "package.json": "{}" }), "1.0.1");
    assert.match(r.output, /no current version known/);
    assert.equal(osvCalls, 0);
  });

  it("keeps the warning and says the advisories could not be checked when OSV is down", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    osvDown = true;
    const cwd = project({ "package.json": "{}", "package-lock.json": lock("1.0.0") });
    const r = await run(cwd, "1.0.1");
    assert.match(r.output, /was published 2 days ago/);
    assert.match(r.output, /advisories could not be checked/);
  });

  it("does not query OSV when air-gap is on and no mirror is named", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    osv.set("fixture@1.0.0", [vuln("GHSA-aaaa-bbbb-cccc", "1.0.1")]);
    const cwd = project({ "package.json": "{}", "package-lock.json": lock("1.0.0") });
    const deps: CoolingDeps = {
      ...defaultCoolingDeps,
      env: { KIT_NPM_REGISTRY: base },
      airGap: async () => true,
    };
    const r = await applyCooling(
      cwd,
      "npm",
      "fixture",
      { passed: true, output: report("1.0.1") },
      deps,
    );
    assert.match(r.output, /advisories not queried: air-gap is on/);
    assert.equal(osvCalls, 0);
  });

  it("queries a named OSV mirror even when air-gap is on", async () => {
    publish({ "1.0.0": 300, "1.0.1": 2 }, "1.0.1");
    osv.set("fixture@1.0.0", [vuln("GHSA-aaaa-bbbb-cccc", "1.0.1")]);
    const cwd = project({ "package.json": "{}", "package-lock.json": lock("1.0.0") });
    const r = await run(cwd, "1.0.1", {}, true);
    assert.match(r.output, /waived/);
    assert.ok(osvCalls > 0);
  });

  it("passes other ecosystems and unreadable reports through unchanged", async () => {
    const cwd = project({ "package.json": "{}" });
    const input = { passed: true, output: report("1.0.1") };
    assert.deepEqual(await applyCooling(cwd, "pip", "fixture", input), input);
    const noVersion = { passed: true, output: "TRIAGE PASSED" };
    assert.deepEqual(await applyCooling(cwd, "npm", "fixture", noVersion), noVersion);
  });

  it("says the registry could not be read again, instead of staying silent", async () => {
    const r = await run(project({ "package.json": "{}" }), "1.0.1");
    assert.match(r.output, /NOT CHECKED: cooling/);
    assert.equal(r.passed, true);
  });
});
