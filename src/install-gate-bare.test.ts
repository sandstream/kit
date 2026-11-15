import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import { TRIAGE_LOG_FILE } from "./triage-receipt.js";

const made: string[] = [];
function project(manifest: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-bare-")));
  made.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function receipt(dir: string, name: string, ageDays = 0, target = name): void {
  const timestamp = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  const line = JSON.stringify({ timestamp, type: "npm", target, sandbox: false, granter: "t" });
  writeFileSync(join(dir, TRIAGE_LOG_FILE), line + "\n", { flag: "a" });
}

const skill = { dependencies: { "axe-core": "4.10.3" }, devDependencies: { playwright: "1.58.0" } };

describe("a bare install of a manifest that no commit gate covers", () => {
  it("is blocked until every direct dependency has a fresh triage receipt", async () => {
    const dir = project(skill);
    const verdict = await decideBashGate("npm install --ignore-scripts", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /axe-core/);
    assert.match(verdict.reason, /playwright/);
    assert.match(verdict.reason, /kit triage npm/);
  });

  it("names only the dependencies that still lack a receipt", async () => {
    const dir = project(skill);
    receipt(dir, "axe-core");
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.doesNotMatch(verdict.reason, /axe-core/);
    assert.match(verdict.reason, /playwright/);
  });

  it("passes when every direct dependency has a fresh receipt", async () => {
    const dir = project(skill);
    receipt(dir, "axe-core");
    receipt(dir, "playwright");
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });

  it("reads a receipt whose target carries a version", async () => {
    const dir = project(skill);
    receipt(dir, "axe-core", 0, "axe-core@4.10.3");
    receipt(dir, "playwright", 0, "playwright@1.58.0");
    assert.equal((await decideBashGate("npm ci", undefined, dir)).block, false);
  });

  it("treats a receipt older than seven days as missing", async () => {
    const dir = project(skill);
    receipt(dir, "axe-core", 8);
    receipt(dir, "playwright");
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /axe-core/);
  });

  it("counts optionalDependencies too", async () => {
    const dir = project({ optionalDependencies: { fsevents: "2.3.2" } });
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /fsevents/);
  });

  for (const command of [
    "npm ci",
    "npm i",
    "npm update",
    "pnpm install",
    "yarn install",
    "yarn",
    "bun install",
  ]) {
    it(`covers \`${command}\``, async () => {
      const dir = project(skill);
      assert.equal((await decideBashGate(command, undefined, dir)).block, true);
    });
  }
});

describe("a bare install: which directory it installs", () => {
  it("follows a leading cd to the directory that is installed", async () => {
    const dir = project(skill);
    const verdict = await decideBashGate(
      `cd ${dir} && npm install --ignore-scripts`,
      undefined,
      tmpdir(),
    );
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /axe-core/);
  });

  it("follows --prefix to the directory that is installed", async () => {
    const dir = project(skill);
    const verdict = await decideBashGate(`npm install --prefix ${dir}`, undefined, tmpdir());
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /axe-core/);
  });

  it("follows -C and the --prefix=<dir> form too", async () => {
    const dir = project(skill);
    for (const command of [
      `npm install -C ${dir}`,
      `npm install --prefix=${dir}`,
      `npm -C ${dir} ci`,
    ]) {
      const verdict = await decideBashGate(command, undefined, tmpdir());
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, /axe-core/, command);
    }
  });

  it("refuses a directory it cannot resolve instead of guessing", async () => {
    const dir = project(skill);
    for (const command of [
      'cd "$TARGET" && npm install',
      "cd $(mktemp -d) && npm install",
      "npm install && cd sub && npm install",
      "pushd sub && npm install",
    ]) {
      const verdict = await decideBashGate(command, undefined, dir);
      assert.equal(verdict.block, true, command);
      assert.match(verdict.reason, /directory/, command);
    }
  });
});

describe("a bare install: what the manifest declares", () => {
  it("refuses a manifest it cannot read", async () => {
    const dir = project("{ not json");
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /package\.json/);
  });

  it("refuses a git or URL dependency, which has no registry triage", async () => {
    for (const spec of [
      "git+https://example.invalid/x.git",
      "https://example.invalid/x.tgz",
      "owner/repo",
    ]) {
      const dir = project({ dependencies: { x: spec } });
      const verdict = await decideBashGate("npm install", undefined, dir);
      assert.equal(verdict.block, true, spec);
      assert.match(verdict.reason, /x/, spec);
    }
  });

  it("triages the real package behind an npm: alias", async () => {
    const dir = project({ dependencies: { alias: "npm:real-pkg@1.0.0" } });
    const verdict = await decideBashGate("npm install", undefined, dir);
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /real-pkg/);
  });

  it("skips local dependencies", async () => {
    const dir = project({ dependencies: { local: "file:../local", linked: "link:../l" } });
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });
});

describe("a bare install that stays allowed", () => {
  it("allows a manifest that git tracks, because check-deps gates it at commit", async () => {
    const dir = project(skill);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "package.json"], { cwd: dir });
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });

  it("allows a directory without a package.json", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-bare-")));
    made.push(dir);
    mkdirSync(join(dir, "sub"));
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });

  it("allows a manifest with no dependencies", async () => {
    const dir = project({ name: "empty" });
    assert.equal((await decideBashGate("npm install", undefined, dir)).block, false);
  });

  it("does nothing when the caller gives no directory", async () => {
    assert.equal((await decideBashGate("npm install")).block, false);
  });

  it("leaves a global bare install alone", async () => {
    const dir = project(skill);
    assert.equal((await decideBashGate("npm install -g", undefined, dir)).block, false);
  });
});

describe("parseInstallCommand marks a bare install", () => {
  it("sets bareInstall for a package-less npm family install", () => {
    for (const command of ["npm install", "npm ci", "pnpm install", "yarn", "bun install"]) {
      assert.equal(parseInstallCommand(command).bareInstall, true, command);
    }
  });

  it("does not set bareInstall when a package is named or for a runner", () => {
    for (const command of ["npm install left-pad", "npx tsc", "echo hi"]) {
      assert.equal(parseInstallCommand(command).bareInstall, false, command);
    }
  });
});
