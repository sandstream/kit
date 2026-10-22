import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLAYWRIGHT_PIN,
  installPlaywright,
  type InstallDeps,
  type InstallResult,
} from "./monkey-test-install.js";

const CHROMIUM = "node /app/node_modules/@playwright/test/cli.js install chromium";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-monkey-install-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

function writePackage(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", ...extra }));
}

function fakeDeps(
  opts: {
    triagePasses?: boolean;
    failOn?: string;
    noCli?: boolean;
    cliVersion?: string;
    verifyOk?: boolean;
    badPackage?: string;
  } = {},
): {
  deps: InstallDeps;
  calls: string[];
  verified: string[];
} {
  const calls: string[] = [];
  const verified: string[] = [];
  const deps: InstallDeps = {
    platform: "linux",
    playwrightCli: () =>
      opts.noCli
        ? null
        : {
            path: "/app/node_modules/@playwright/test/cli.js",
            version: opts.cliVersion ?? PLAYWRIGHT_PIN,
            packages: [
              {
                name: "@playwright/test",
                dir: "/app/a",
                version: opts.cliVersion ?? PLAYWRIGHT_PIN,
              },
              { name: "playwright", dir: "/app/b", version: PLAYWRIGHT_PIN },
              { name: "playwright-core", dir: "/app/c", version: PLAYWRIGHT_PIN },
            ],
          },
    async verifyPackage(name) {
      verified.push(name);
      return opts.verifyOk === false || name === opts.badPackage
        ? { ok: false, detail: "modified: cli.js" }
        : { ok: true, detail: "match" };
    },
    async triage(target) {
      calls.push(`triage ${target}`);
      return { passed: opts.triagePasses ?? true, output: "triage output" };
    },
    async run(command, args) {
      calls.push([command, ...args].join(" "));
      const ok = opts.failOn === undefined || !args.includes(opts.failOn);
      return { ok, output: ok ? "" : "boom" };
    },
  };
  return { deps, calls, verified };
}

function step(result: InstallResult, name: string): { status: string; detail: string } {
  const found = result.steps.find((entry) => entry.name === name);
  assert.ok(found, `step ${name} missing in ${JSON.stringify(result.steps)}`);
  return found;
}

describe("installPlaywright", () => {
  it("triages the pinned version, installs it without scripts, then fetches chromium", async () => {
    writePackage();
    const { deps, calls } = fakeDeps();
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, true, JSON.stringify(result.steps));
    assert.deepEqual(calls, [
      `triage @playwright/test@${PLAYWRIGHT_PIN}`,
      `npm install --save-dev --save-exact --ignore-scripts @playwright/test@${PLAYWRIGHT_PIN}`,
      CHROMIUM,
    ]);
  });

  it("uses the project's package manager", async () => {
    writePackage({ packageManager: "pnpm@9.0.0" });
    const { deps, calls } = fakeDeps();
    await installPlaywright(dir, deps);

    assert.match(calls[1], /^pnpm add --save-dev --save-exact --ignore-scripts /);
    assert.equal(calls[2], CHROMIUM);
  });

  it("installs nothing when triage fails", async () => {
    writePackage();
    const { deps, calls } = fakeDeps({ triagePasses: false });
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, false);
    assert.equal(step(result, "triage").status, "fail");
    assert.deepEqual(calls, [`triage @playwright/test@${PLAYWRIGHT_PIN}`]);
  });

  it("skips install when the dependency is declared, but triages the installed version before fetching chromium", async () => {
    writePackage({ devDependencies: { "@playwright/test": "1.50.0" } });
    const { deps, calls } = fakeDeps({ cliVersion: "1.50.0" });
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, true);
    assert.equal(step(result, "dependency").status, "skip");
    assert.deepEqual(calls, ["triage @playwright/test@1.50.0", CHROMIUM]);
  });

  it("stops before the browser download when the install fails", async () => {
    writePackage();
    const { deps, calls } = fakeDeps({ failOn: "install" });
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, false);
    assert.equal(step(result, "install").status, "fail");
    assert.equal(calls.length, 2);
  });
});

describe("installPlaywright refusals", () => {
  it("fails clearly without a package.json", async () => {
    const { deps, calls } = fakeDeps();
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, false);
    assert.match(step(result, "package").detail, /package\.json/);
    assert.deepEqual(calls, []);
  });

  it("prints the commands instead of running them on Windows", async () => {
    writePackage();
    const { deps, calls } = fakeDeps();
    const result = await installPlaywright(dir, { ...deps, platform: "win32" });

    assert.equal(result.ok, false);
    assert.match(step(result, "install").detail, /npm install --save-dev/);
    assert.deepEqual(calls, []);
  });

  it("fails the browser step when the cli is not installed, and never falls back to a package runner", async () => {
    writePackage({ devDependencies: { "@playwright/test": "1.50.0" } });
    const { deps, calls } = fakeDeps({ noCli: true });
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, false);
    assert.match(step(result, "browser").detail, /not installed/);
    assert.deepEqual(calls, []);
  });

  it("does not run the browser download when the installed version fails triage", async () => {
    writePackage({ devDependencies: { "@playwright/test": "1.50.0" } });
    const { deps, calls } = fakeDeps({ triagePasses: false, cliVersion: "1.50.0" });
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, false);
    assert.match(step(result, "browser").detail, /failed triage/);
    assert.deepEqual(calls, ["triage @playwright/test@1.50.0"]);
  });

  it("refuses to install when the repo runs its own code during install", async () => {
    writePackage({ packageManager: "pnpm@9.0.0" });
    writeFileSync(join(dir, ".pnpmfile.cjs"), "module.exports = {};");
    const { deps, calls } = fakeDeps();
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, false);
    assert.match(step(result, "install").detail, /pnpmfile/);
    assert.deepEqual(calls, []);
  });

  it("refuses a custom yarn binary", async () => {
    writePackage({ packageManager: "yarn@4.0.0" });
    writeFileSync(join(dir, ".yarnrc.yml"), "yarnPath: .yarn/releases/yarn.cjs\n");
    const { deps, calls } = fakeDeps();
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, false);
    assert.match(step(result, "install").detail, /custom yarn/);
    assert.deepEqual(calls, []);
  });
});

describe("installPlaywright package checks", () => {
  it("does not run the installed cli when its files differ from the registry tarball", async () => {
    writePackage({ devDependencies: { "@playwright/test": "1.55.0" } });
    const { deps, calls } = fakeDeps({ verifyOk: false });
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, false);
    assert.match(
      step(result, "browser").detail,
      /Refused to run the installed cli: @playwright\/test@1\.55\.0: modified: cli\.js/,
    );
    assert.ok(!calls.includes(CHROMIUM));
  });

  it("refuses a packageManager that corepack could fetch from a URL", async () => {
    writePackage({ packageManager: "yarn@https://example.test/yarn.js" });
    const { deps, calls } = fakeDeps();
    const result = await installPlaywright(dir, deps);

    assert.equal(result.ok, false);
    assert.match(step(result, "package").detail, /not a plain name@version/);
    assert.deepEqual(calls, []);
  });

  it("verifies all three packages whose code runs, and refuses on a bad dependency", async () => {
    writePackage({ devDependencies: { "@playwright/test": "1.55.0" } });
    const ok = fakeDeps();
    await installPlaywright(dir, ok.deps);
    assert.deepEqual(ok.verified, ["@playwright/test", "playwright", "playwright-core"]);

    const bad = fakeDeps({ badPackage: "playwright-core" });
    const result = await installPlaywright(dir, bad.deps);
    assert.equal(result.ok, false);
    assert.match(step(result, "browser").detail, /playwright-core@1\.55\.0: modified/);
    assert.ok(!bad.calls.includes(CHROMIUM));
  });
});
