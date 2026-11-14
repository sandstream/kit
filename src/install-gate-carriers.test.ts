import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";

describe("install gate command carriers", () => {
  it("refuses an env split string before any registry request", async () => {
    const verdict = await decideBashGate("env -S npm i gate-fixture", {
      runTriage: async () => {
        throw new Error("An unresolved command must not reach registry triage");
      },
    });
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /env.*split.string/i);
    assert.deepEqual(verdict.checked, []);
  });

  it("keeps ordinary env options and assignments available", () => {
    const probe = parseInstallCommand("env -u UNUSED FLAG=value npm i gate-fixture");
    assert.deepEqual(probe.refs, ["npm:gate-fixture"]);
    assert.deepEqual(probe.unverifiable, []);
  });

  for (const command of [
    'env -S "npm i gate-fixture"',
    'env --split-string="npm i gate-fixture"',
    'env --split-string "npm i gate-fixture"',
    'env -S"npm i gate-fixture"',
    'env -vS "npm i gate-fixture"',
    'sudo -u operator env -S "npm i gate-fixture"',
    '/usr/bin/env -S "npm i gate-fixture"',
    'env -vu sh -S "npm i gate-fixture"',
    'env \\-S "npm i gate-fixture"',
    'sudo -u operator env -vu sh -S "npm i gate-fixture"',
  ]) {
    it(`refuses the unresolved command: ${command}`, () => {
      const probe = parseInstallCommand(command);
      assert.equal(probe.isInstall, true);
      assert.ok(probe.unverifiable.includes("wrapper-command:env split-string"));
    });
  }
});

describe("install gate wrapper argument boundaries", () => {
  for (const comment of ["don't change this", 'a "quoted note', "install; npm i comment-only"]) {
    it(`ignores comment syntax before the next command: ${comment}`, () => {
      const probe = parseInstallCommand(`echo ready # ${comment}\nnpm i gate-fixture`);
      assert.deepEqual(probe.refs, ["npm:gate-fixture"]);
    });
  }

  it("does not mistake command data for env options", () => {
    assert.equal(parseInstallCommand("echo env -S npm i gate-fixture").isInstall, false);
    const probe = parseInstallCommand("env -u SPLIT MODE=-S npm i gate-fixture");
    assert.deepEqual(probe.refs, ["npm:gate-fixture"]);
    assert.deepEqual(probe.unverifiable, []);
  });

  it("does not read an attached unset value as an env split-string flag", () => {
    const probe = parseInstallCommand("env -uSHELL npm i gate-fixture");
    assert.deepEqual(probe.refs, ["npm:gate-fixture"]);
    assert.deepEqual(probe.unverifiable, []);
  });

  for (const command of ["env git show -Sneedle", "env echo -S hello", "sudo echo npm i text"]) {
    it(`stops wrapper options at the actual command: ${command}`, () => {
      assert.equal(parseInstallCommand(command).isInstall, false);
    });
  }

  for (const command of [
    "env -vu sh npm i gate-fixture",
    "sudo -nu root npm i gate-fixture",
    "sudo --user root npm i gate-fixture",
    "env --unset=UNUSED npm i gate-fixture",
    "timeout --signal TERM 60 npm i gate-fixture",
    "env -vuSHLVL npm i gate-fixture",
    "env -- npm i gate-fixture",
    'sudo -p "Enter password: " npm i gate-fixture',
    'sudo -p "" npm i gate-fixture',
    'env -C "/tmp/space path" npm i gate-fixture',
    'flock "/tmp/space lock" npm i gate-fixture',
    'sudo -p "Enter; password | now: " npm i gate-fixture',
    'sudo -p "Prompt # text" npm i gate-fixture',
    "env -u FOO \\\nnpm i gate-fixture",
    "env -u FOO n\\pm i gate-fixture",
    "env -u FOO\\ #VALUE npm i gate-fixture",
  ]) {
    it(`consumes the wrapper option value: ${command}`, () => {
      assert.deepEqual(parseInstallCommand(command).refs, ["npm:gate-fixture"]);
    });
  }

  for (const command of [
    'flock /tmp/lock -c "npm i gate-fixture"',
    'flock -c "npm i gate-fixture" /tmp/lock',
  ]) {
    it(`refuses a lock wrapper command string: ${command}`, () => {
      assert.ok(parseInstallCommand(command).unverifiable.length > 0);
    });
  }

  it("refuses unknown wrapper syntax without guessing a command boundary", () => {
    const probe = parseInstallCommand("env --unknown value npm i gate-fixture");
    assert.equal(probe.isInstall, true);
    assert.match(probe.unverifiable[0], /^wrapper-option:/);
  });

  it("does not run the contents of a quoted argument", () => {
    assert.equal(parseInstallCommand('env echo "example; npm i gate-fixture"').isInstall, false);
  });
});

describe("install gate source configuration", () => {
  it("refuses an equals-form config file before registry triage", async () => {
    const verdict = await decideBashGate("uv --config-file=/tmp/config add gate-fixture", {
      runTriage: async () => {
        throw new Error("A redirected source must not reach public registry triage");
      },
    });
    assert.equal(verdict.block, true);
    assert.deepEqual(verdict.checked, []);
  });

  for (const command of [
    "uv --config-file /tmp/config add gate-fixture",
    "uv add gate-fixture --config-file=/tmp/config",
    "uv add --config-file /tmp/config gate-fixture",
    "pdm --config=/tmp/config add gate-fixture",
    "pdm -c/tmp/config add gate-fixture",
    "pdm add gate-fixture -c/tmp/config",
    "pdm add --config /tmp/config gate-fixture",
    "pipx install gate-fixture --pip-args=--pre",
    'pipx --pip-args "--pre" install gate-fixture',
    "pipx run --pip-args=--pre gate-fixture",
    "uvx --config-file=/tmp/config gate-fixture",
    "uv pip install --config-file=/tmp/config",
    "uv --config-file /tmp/config tool run gate-fixture",
    "uv --config-file /tmp/config run --with gate-fixture script.py",
    'pipx --pip-args "--trusted-host packages.example" run gate-fixture',
    "uv run --group dev --config-file=/tmp/config --with gate-fixture python script.py",
    "uv run --group=dev --config-file=/tmp/config --with gate-fixture python script.py",
    "uv run --future-option value --config-file=/tmp/config --with gate-fixture python script.py",
    "uvx --cache-dir /tmp --config-file=/tmp/config gate-fixture",
    "uvx --cache-dir /tmp --config-file /tmp/config gate-fixture",
    "pdm -vc/tmp/config add gate-fixture",
    "pdm -vc /tmp/config add gate-fixture",
  ]) {
    it(`refuses an uninspected source: ${command}`, () => {
      const probe = parseInstallCommand(command);
      assert.equal(probe.isInstall, true);
      assert.ok(probe.unverifiable.length > 0, "Source configuration must remain unverified");
    });
  }

  it("keeps pip constraints separate from pdm source configuration", () => {
    const probe = parseInstallCommand("pip install -c /tmp/constraints gate-fixture");
    assert.deepEqual(probe.refs, ["pip:gate-fixture"]);
    assert.deepEqual(probe.unverifiable, []);
  });

  it("does not mistake a PDM project path for a short config option", () => {
    const probe = parseInstallCommand("pdm -pcache add gate-fixture");
    assert.deepEqual(probe.refs, ["pip:gate-fixture"]);
    assert.deepEqual(probe.unverifiable, []);
  });

  it("does not treat an unrelated command or a list operation as an install", () => {
    assert.equal(parseInstallCommand("git --config=/tmp/config status").isInstall, false);
    assert.equal(parseInstallCommand("pdm --config=/tmp/config list").isInstall, false);
  });

  for (const command of [
    "uv run -- python app.py --config-file=settings.toml",
    "uv run python app.py --config-file=settings.toml",
    "uv run --group dev python app.py --config-file=settings.toml",
    "uv run --offline python app.py --config-file=settings.toml",
  ]) {
    it(`keeps child configuration out of the manager scope: ${command}`, () => {
      assert.equal(parseInstallCommand(command).isInstall, false);
    });
  }

  it("still triages a package runner when its child has a configuration option", () => {
    const probe = parseInstallCommand("uv tool run gate-fixture --config-file=settings.toml");
    assert.deepEqual(probe.refs, ["pip:gate-fixture"]);
    assert.deepEqual(probe.unverifiable, []);
  });
});
