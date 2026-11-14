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

describe("install gate — review findings on the flag reader", () => {
  it("fails closed when an unknown option may have swallowed a verb and a fetch verb follows", () => {
    // `--frobnicate run` may be an option with the value `run`, and then `install evil-x` runs.
    const p = parseInstallCommand("npm --frobnicate run install evil-x");
    assert.equal(p.isInstall, true);
    assert.deepEqual(p.unverifiable, ["global-option:npm --frobnicate run"]);
  });

  it("still lets an unknown option pass when its slot holds the fetch verb itself", () => {
    assert.deepEqual(refsOf("npm --frobnicate install evil-x"), ["npm:evil-x"]);
    assert.equal(parseInstallCommand("npm --frobnicate run build").isInstall, false);
  });

  const unknownOption = [
    "pip --frobnicate thing install evil-x",
    "pip3 --frobnicate thing install evil-x",
    "pipx --frobnicate thing install evil-x",
    "poetry --frobnicate thing add evil-x",
    "pdm --frobnicate thing add evil-x",
  ];
  for (const cmd of unknownOption) {
    it(`fails closed on an unknown option before the subcommand: ${cmd}`, () => {
      const p = parseInstallCommand(cmd);
      assert.equal(p.isInstall, true);
      assert.equal(p.unverifiable.length, 1, p.unverifiable.join());
      assert.match(p.unverifiable[0], /^global-option:/);
    });
  }

  const knownValueOption = [
    "pip --proxy http://proxy.local:3128 install evil-x",
    "pip3 --cache-dir /tmp/c install evil-x",
    "pip --python /usr/bin/python3 install evil-x",
    "pipx --python 3.12 install evil-x",
    "poetry -C /tmp/x add evil-x",
    "pdm -p /tmp/x add evil-x",
  ];
  for (const cmd of knownValueOption) {
    it(`reads a known value option and triages: ${cmd}`, () => {
      const p = parseInstallCommand(cmd);
      assert.equal(p.isInstall, true);
      assert.deepEqual(p.unverifiable, []);
      assert.deepEqual(p.refs.length, 1);
    });
  }

  it("does not apply the fail-closed rule to a command that is not a package manager", () => {
    assert.equal(parseInstallCommand("git --frobnicate thing install add").isInstall, false);
    assert.equal(parseInstallCommand("make --frobnicate thing install").isInstall, false);
  });

  it("finds the command behind a wrapper however many values it takes", () => {
    assert.deepEqual(refsOf("sudo -u root -g wheel -h host -p prompt npm i evil-x"), [
      "npm:evil-x",
    ]);
    assert.deepEqual(refsOf("timeout -s KILL -k 5 60 npm i evil-x"), ["npm:evil-x"]);
  });

  it("still reads a wrapper that runs something else as not an install", () => {
    assert.equal(
      parseInstallCommand("sudo -u root -g wheel -h host -p prompt vim x").isInstall,
      false,
    );
  });
});

describe("install gate — second review of the flag reader", () => {
  it("does not treat a runner or initiator verb in the slot as proof that an option took no value", () => {
    // `--frobnicate exec` may be an option with the value `exec`; `install evil-x` then runs.
    const p = parseInstallCommand("npm --frobnicate exec install evil-x");
    assert.equal(p.isInstall, true);
    assert.deepEqual(p.unverifiable, ["runner-option:--frobnicate"]);
  });

  it("reads the value of a wrapper's own option as a value, even when it is named like a command", () => {
    // The user of `sudo -u` here is called `pip`; the command is `npm i evil-x`.
    assert.deepEqual(refsOf("sudo -u pip npm i evil-x"), ["npm:evil-x"]);
    assert.deepEqual(refsOf("env -u pip npm i evil-x"), ["npm:evil-x"]);
    assert.deepEqual(refsOf("sudo -g python3 -h uv npm i evil-x"), ["npm:evil-x"]);
  });

  const redirectingOptions = [
    "pdm -c /tmp/evil.toml add evil-x",
    "pdm --config /tmp/evil.toml add evil-x",
    "pipx --pip-args foo install evil-x",
    "uv --config-file /tmp/evil.toml pip install evil-x",
  ];
  for (const cmd of redirectingOptions) {
    it(`fails closed on an option that can carry a registry: ${cmd}`, () => {
      const p = parseInstallCommand(cmd);
      assert.equal(p.isInstall, true);
      assert.ok(
        p.unverifiable.some((u) => u.startsWith("global-option:")),
        p.unverifiable.join(),
      );
    });
  }
});

describe("install gate — cases found by mutation testing", () => {
  // kit-research mutation-testing-vs-kit-gates: each case kills a mutant that let the install
  // through while every existing test still passed.
  it("reads an install behind doas", () => {
    assert.deepEqual(refsOf("doas npm i evil-x"), ["npm:evil-x"]);
  });

  for (const verb of ["exec", "x", "dlx", "create", "init"]) {
    it(`fails closed when an unknown option precedes the fetch verb ${verb}`, () => {
      const p = parseInstallCommand(`npm --foo bar ${verb} evil-x`);
      assert.equal(p.isInstall, true);
      assert.deepEqual(p.unverifiable, ["global-option:npm --foo bar"]);
    });
  }
});
