/**
 * The version in use, for the cooling waiver. A cooling check printed "no current version known, so
 * a security patch cannot be recognised" with 7.5.0 installed globally (owner report, 2026-11-26):
 * kit read only the project lockfile, so `npm i -g`, a `node_modules` with no lockfile, every pip
 * triage and every `gem install` held a first-fix security release for the full cooling period.
 *
 * These run `applyCooling` and `triageGem` with a stub registry and a stub OSV (no network), a fake
 * npm prefix and fake site-packages. Both npm layouts run on every OS: the platform is injected.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { applyCooling, type CoolingDeps, type OsvVuln } from "./triage-cooling.js";
import {
  distInfoVersion,
  installedGemVersion,
  npmGlobalRoot,
  pep503,
  type InstallLocator,
} from "./triage-current-version.js";
import { triageGem } from "./triage-gem.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-26T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function dir(t: { after: (fn: () => void) => void }, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kit-current-"));
  t.after(() => rmTemp(root));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const manifest = (version: string, name = "fixture") => JSON.stringify({ name, version });
const lock = (version: string) =>
  JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/fixture": { version } } });

/** An advisory for `name` affecting versions below `fixed`. */
const vuln = (id: string, fixed: string, name = "fixture"): OsvVuln => ({
  id,
  affected: [
    {
      package: { name },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed }] }],
    },
  ],
});

/** 7.5.0 has GHSA-fixture-0001, fixed in 7.5.1, published two days ago. */
const ADVISORY: Record<string, OsvVuln[]> = {
  "fixture@7.5.0": [vuln("GHSA-fixture-0001", "7.5.1")],
};
const PUBLISHED: Record<string, number> = { "7.4.0": 300, "7.5.0": 100, "7.5.1": 2 };

/** A locator for a node binary at `execPath`, with no Python site-packages. */
const locator = (over: Partial<InstallLocator> = {}): InstallLocator => ({
  platform: "linux",
  execPath: join(tmpdir(), "kit-current-no-such-node", "bin", "node"),
  home: join(tmpdir(), "kit-current-no-such-home"),
  sitePackages: async () => [],
  ...over,
});

function deps(
  over: Partial<CoolingDeps> = {},
  advisories: Record<string, OsvVuln[]> = ADVISORY,
  published: Record<string, number> = PUBLISHED,
): CoolingDeps {
  return {
    env: {},
    now: () => NOW,
    getJson: async () => ({
      versions: Object.fromEntries(Object.keys(published).map((v) => [v, {}])),
      time: Object.fromEntries(Object.entries(published).map(([v, d]) => [v, ago(d)])),
    }),
    postJson: async (_url, body) => {
      const q = body as { package: { name: string }; version: string };
      const vulns = advisories[`${q.package.name}@${q.version}`] ?? [];
      return vulns.length ? { vulns } : {};
    },
    airGap: async () => ({ enabled: false, mirrors: {} }),
    locator: locator(),
    ...over,
  };
}

const report = (v: string) =>
  `Triage: npm fixture\n  . triaged ${v}, 3 versions\n\nHealth score: 100/100\nCritical issues: 0\nWarnings: 0\nTRIAGE PASSED\n`;

const triage = (cwd: string, d: CoolingDeps, target = "fixture@7.5.1", type = "npm") =>
  applyCooling(cwd, type, target, { passed: true, output: report("7.5.1") }, d);

const WAIVED = /cooling: waived, 7\.5\.1 fixes GHSA-fixture-0001 \(the first release that does; /;

describe("current version: npm's global install", () => {
  it("waives the first fix for 7.5.0 installed under npm_config_prefix (POSIX layout)", async (t) => {
    const prefix = dir(t, { "lib/node_modules/fixture/package.json": manifest("7.5.0") });
    const r = await triage(dir(t), deps({ env: { npm_config_prefix: prefix } }));
    assert.match(r.output, WAIVED);
    assert.match(r.output, /current 7\.5\.0 from the global install\)/);
    assert.doesNotMatch(r.output, /no current version known/);
    assert.equal(r.passed, true, r.output);
  });

  it("finds an nvm-style prefix from the node binary kit runs (<prefix>/bin/node)", async (t) => {
    const prefix = dir(t, { "lib/node_modules/fixture/package.json": manifest("7.5.0") });
    const execPath = join(prefix, "bin", "node");
    const r = await triage(dir(t), deps({ locator: locator({ execPath }) }));
    assert.match(r.output, /current 7\.5\.0 from the global install/);
    assert.equal(r.passed, true, r.output);
  });

  it("reads the Windows layout, <prefix>\\node_modules beside node.exe", async (t) => {
    const prefix = dir(t, { "node_modules/fixture/package.json": manifest("7.5.0") });
    const win = locator({ platform: "win32", execPath: join(prefix, "node.exe") });
    const r = await triage(dir(t), deps({ locator: win }));
    assert.match(r.output, /current 7\.5\.0 from the global install/);
    assert.equal(r.passed, true, r.output);
    const viaEnv = await triage(
      dir(t),
      deps({ env: { npm_config_prefix: prefix }, locator: locator({ platform: "win32" }) }),
    );
    assert.equal(viaEnv.passed, true, viaEnv.output);
  });

  it("works out npm's global root without running npm", (t) => {
    const home = dir(t, { ".npmrc": "registry=https://r.example/\nprefix=~/.npm-global\n" });
    const exec = join("opt", "node", "bin", "node");
    const posix = locator({ execPath: exec });
    assert.equal(npmGlobalRoot({}, posix), join("opt", "node", "lib", "node_modules"));
    assert.equal(npmGlobalRoot({ PREFIX: "p" }, posix), join("p", "lib", "node_modules"));
    const winExec = join("C", "nodejs", "node.exe");
    const win = locator({ platform: "win32", execPath: winExec });
    assert.equal(npmGlobalRoot({}, win), join("C", "nodejs", "node_modules"));
    assert.equal(
      npmGlobalRoot({}, locator({ home })),
      join(home, ".npm-global", "lib", "node_modules"),
      "the user npmrc's prefix, as npm reads it",
    );
    const unresolved = dir(t, { ".npmrc": "prefix=${HOME}/x\n" });
    assert.equal(npmGlobalRoot({}, locator({ home: unresolved })), null);
  });
});

describe("current version: node_modules and the lockfile", () => {
  it("waives from node_modules when there is no lockfile", async (t) => {
    const cwd = dir(t, {
      "package.json": "{}",
      "node_modules/fixture/package.json": manifest("7.5.0"),
    });
    const r = await triage(cwd, deps());
    assert.match(r.output, WAIVED);
    assert.match(r.output, /current 7\.5\.0 from node_modules\)/);
    assert.equal(r.passed, true, r.output);
  });

  it("lets the lockfile win over node_modules and says so", async (t) => {
    // node_modules has 7.4.0, whose own advisory is first fixed by 7.4.1: read, it would refuse.
    const cwd = dir(t, {
      "package.json": "{}",
      "package-lock.json": lock("7.5.0"),
      "node_modules/fixture/package.json": manifest("7.4.0"),
    });
    const advisories = { ...ADVISORY, "fixture@7.4.0": [vuln("GHSA-fixture-0002", "7.4.1")] };
    const published = { ...PUBLISHED, "7.4.1": 200 };
    const r = await triage(cwd, deps({}, advisories, published));
    assert.match(r.output, /current 7\.5\.0 from the project lockfile\)/);
    assert.equal(r.passed, true, r.output);
  });

  it("does not let a package.json for another name stand in for the package", async (t) => {
    const cwd = dir(t, { "node_modules/fixture/package.json": manifest("7.5.0", "other") });
    const r = await triage(cwd, deps());
    assert.match(r.output, /no current version known/);
    assert.equal(r.passed, false);
  });
});

describe("current version: trust no one", () => {
  it("treats an installed version the registry never published as unknown", async (t) => {
    const prefix = dir(t, { "lib/node_modules/fixture/package.json": manifest("7.5.0-evil") });
    // Even an advisory that would waive for that version must not be asked about it.
    const advisories = { ...ADVISORY, "fixture@7.5.0-evil": [vuln("GHSA-x", "7.5.1")] };
    const cwd = dir(t, { "node_modules/fixture/package.json": manifest("7.5.0") });
    const r = await triage(cwd, deps({ env: { npm_config_prefix: prefix } }, advisories));
    assert.match(
      r.output,
      /no current version known \(the global install has 7\.5\.0-evil, which the registry has never published\)/,
    );
    assert.doesNotMatch(r.output, /waived/);
    assert.equal(r.passed, false, "it does not fall through to a source further down");
  });

  it("never skips the cooling period because an installed copy already has the candidate", async (t) => {
    const cwd = dir(t, { "node_modules/fixture/package.json": manifest("7.5.1") });
    const r = await triage(cwd, deps());
    assert.match(r.output, /x CRITICAL: cooling: 7\.5\.1 was published 2 days ago/);
    assert.match(r.output, /current 7\.5\.1 from node_modules/);
    assert.equal(r.passed, false);
    const pinned = dir(t, { "package.json": "{}", "package-lock.json": lock("7.5.1") });
    assert.equal((await triage(pinned, deps())).passed, true, "a lockfile pin still skips it");
  });

  it("names every source it checked when none has the package", async (t) => {
    const prefix = dir(t);
    const r = await triage(dir(t), deps({ env: { npm_config_prefix: prefix } }));
    const root = join(prefix, "lib", "node_modules");
    assert.ok(
      r.output.includes(
        `(no current version known (checked the project lockfile, the global install (${root}), node_modules), so a security patch cannot be recognised)`,
      ),
      r.output,
    );
    assert.equal(r.passed, false);
  });
});

describe("current version: pip's installed dist-info", () => {
  const pypi = {
    releases: {
      "1.0.0": [{ upload_time_iso_8601: ago(90) }],
      "1.0.1": [{ upload_time_iso_8601: ago(2) }],
    },
  };
  const advisories = { "fixture.pkg@1.0.0": [vuln("PYSEC-0001", "1.0.1", "fixture.pkg")] };
  const metadata = (name: string, version: string) =>
    `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n\nVersion: 9.9.9 in the body\n`;

  it("waives from <site-packages>/<name>-<version>.dist-info, names normalised per PEP 503", async (t) => {
    const site = dir(t, {
      "fixture_pkg-1.0.0.dist-info/METADATA": metadata("Fixture.Pkg", "1.0.0"),
    });
    const d = deps(
      { getJson: async () => pypi, locator: locator({ sitePackages: async () => [site] }) },
      advisories,
    );
    const r = await applyCooling(
      dir(t),
      "pip",
      "fixture.pkg==1.0.1",
      { passed: true, output: report("1.0.1") },
      d,
    );
    assert.match(r.output, /cooling: waived, 1\.0\.1 fixes PYSEC-0001/);
    assert.match(r.output, /current 1\.0\.0 from the installed dist-info/);
    assert.equal(r.passed, true, r.output);
  });

  it("reads the first site-packages in import order, and only a matching Name header", (t) => {
    const first = dir(t, {
      "Fixture-Pkg-1.0.0.dist-info/METADATA": metadata("fixture-pkg", "1.0.0"),
    });
    const second = dir(t, { "fixture_pkg-0.9.dist-info/METADATA": metadata("fixture_pkg", "0.9") });
    const liar = dir(t, { "fixture_pkg-2.0.dist-info/METADATA": metadata("other", "2.0") });
    assert.equal(distInfoVersion([first, second], "FIXTURE_pkg"), "1.0.0");
    assert.equal(distInfoVersion([join(first, "missing"), second], "fixture.pkg"), "0.9");
    assert.equal(distInfoVersion([liar], "fixture-pkg"), undefined);
    assert.equal(pep503("Foo__Bar.baz"), "foo-bar-baz");
  });

  it("names what it checked when nothing is installed", async (t) => {
    const d = deps({ getJson: async () => pypi }, advisories);
    const r = await applyCooling(
      dir(t),
      "pip",
      "fixture.pkg",
      { passed: true, output: report("1.0.1") },
      d,
    );
    assert.match(
      r.output,
      /no current version known \(checked a lockfile \(pip has none kit reads\), the dist-info in python3's site-packages\)/,
    );
    assert.equal(r.passed, false);
  });
});

describe("current version: installed gems", () => {
  const doc = [
    { number: "2.0.1", created_at: ago(1), downloads_count: 5_000 },
    { number: "2.0.0", created_at: ago(100), downloads_count: 5_000 },
  ];
  const gemDeps = (env: NodeJS.ProcessEnv) => ({
    ...deps({ env }, { "fixture@2.0.0": [vuln("GHSA-gem-0001", "2.0.1")] }),
    getJson: async () => doc,
    lockfile: () => null,
  });

  it("waives from a gemspec under GEM_HOME when there is no Gemfile.lock", async (t) => {
    const home = dir(t, {
      "specifications/fixture-2.0.0.gemspec": "# Ruby code, never run\n",
      "specifications/fixture-extra-9.0.0.gemspec": "",
    });
    const r = await triageGem(dir(t), "fixture", gemDeps({ GEM_HOME: home }));
    assert.match(r.output, /cooling: waived, 2\.0\.1 fixes GHSA-gem-0001/);
    assert.match(r.output, /current 2\.0\.0 from the installed gems/);
    assert.equal(r.passed, true, r.output);
  });

  it("names what it checked when GEM_HOME and GEM_PATH are not set", async (t) => {
    const r = await triageGem(dir(t), "fixture", gemDeps({}));
    assert.match(
      r.output,
      /checked Gemfile\.lock, the installed gems \(GEM_HOME and GEM_PATH are not set/,
    );
    assert.equal(r.passed, false);
  });

  it("takes the newest published version and ignores a platform suffix", (t) => {
    const a = dir(t, {
      "specifications/fixture-1.9.0-x86_64-linux.gemspec": "",
      "specifications/fixture-2.0.0.gemspec": "",
      "specifications/fixture-10.0.0.gemspec": "",
    });
    assert.equal(installedGemVersion([a], "fixture", ["1.9.0", "2.0.0"]), "2.0.0");
    assert.equal(installedGemVersion([a], "fixture", ["1.9.0", "2.0.0", "10.0.0"]), "10.0.0");
    assert.equal(
      installedGemVersion([a], "fixture", []),
      "10.0.0",
      "unpublished: the caller refuses it",
    );
  });
});
