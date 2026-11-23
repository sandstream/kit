/**
 * kit-research opencomputer-vs-kit: kit kept its gates out of a tracked settings.json, so a fresh
 * checkout on an agent host had none. The portable line can be committed: it runs kit where kit
 * is, and refuses where it is not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { commandIncludesSubcommand } from "./agent-config-hook-liveness.js";
import { kitGateCommands } from "./gate-self-edit.js";
import {
  effectiveHookCommand,
  holdsPortableGate,
  portableGateCommand,
  portableGateSubcommand,
  portableGatesMode,
} from "./portable-gate.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const POSIX = process.platform !== "win32";
const LINE = portableGateCommand("gate-bash");
const settingsWith = (command: string) =>
  JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
  });

function temp(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmTemp(dir));
  return dir;
}

function fakeKit(dir: string, body = "exit 0"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "kit");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("the portable gate line", () => {
  it("is recognised by exact text only", () => {
    assert.equal(portableGateSubcommand(LINE), "gate-bash");
    assert.equal(portableGateSubcommand(portableGateCommand("gate-env")), "gate-env");
    assert.equal(portableGateSubcommand(LINE.replace("exit 2", "exit 0")), null);
    assert.equal(portableGateSubcommand('"$HOME/.kit/bin/kit" gate-bash'), null);
  });

  it("counts as a kit gate for the liveness check and the self-edit refusal", () => {
    assert.equal(commandIncludesSubcommand(LINE, "gate-bash"), true);
    assert.equal(commandIncludesSubcommand(LINE, "gate-env"), false);
    assert.deepEqual(kitGateCommands(settingsWith(LINE)), [LINE]);
  });
});

describe(
  "effectiveHookCommand",
  { skip: POSIX ? false : "the wrapper and the fake kit are POSIX sh" },
  () => {
    it("resolves to the wrapper, then to kit on PATH, then to a bare kit", (t) => {
      const home = temp(t, "kit-portable-home-");
      const bin = temp(t, "kit-portable-bin-");
      assert.equal(effectiveHookCommand(LINE, { PATH: "" }, home), "kit gate-bash");
      const onPath = fakeKit(bin);
      assert.equal(effectiveHookCommand(LINE, { PATH: bin }, home), `"${onPath}" gate-bash`);
      const wrapper = fakeKit(join(home, ".kit", "bin"));
      assert.equal(effectiveHookCommand(LINE, { PATH: bin }, home), `"${wrapper}" gate-bash`);
    });

    it("leaves every other command unchanged", () => {
      assert.equal(effectiveHookCommand("node x.js gate-bash"), "node x.js gate-bash");
    });
  },
);

describe(
  "running the line",
  { skip: POSIX ? false : "the line is POSIX sh; unverified on Windows" },
  () => {
    const run = (home: string, path: string) =>
      spawnSync("sh", ["-c", LINE], {
        input: "{}",
        encoding: "utf-8",
        env: { HOME: home, PATH: path },
        timeout: 30_000,
      });
    const system = ["/usr/bin", "/bin"].join(delimiter);

    it("refuses with exit 2 and says how to install kit when kit is missing", (t) => {
      const r = run(temp(t, "kit-portable-none-"), system);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /kit is not installed here.*npm i -g sandstream-kit/);
    });

    it("runs kit from PATH with the gate subcommand, and the wrapper first when there is one", (t) => {
      const home = temp(t, "kit-portable-run-");
      const bin = temp(t, "kit-portable-runbin-");
      fakeKit(bin, 'echo "path $1"; exit 0');
      assert.equal(run(home, `${bin}${delimiter}${system}`).stdout.trim(), "path gate-bash");
      fakeKit(join(home, ".kit", "bin"), 'echo "wrapper $1"; exit 2');
      const r = run(home, `${bin}${delimiter}${system}`);
      assert.equal(r.stdout.trim(), "wrapper gate-bash");
      assert.equal(r.status, 2, "the gate's own exit code is the line's exit code");
    });
  },
);

describe("portableGatesMode", () => {
  it("is on with the flag, and stays on once the shared settings hold a portable line", (t) => {
    const dir = temp(t, "kit-portable-mode-");
    assert.equal(portableGatesMode(dir, ["node", "kit", "agent-config"]), false);
    assert.equal(portableGatesMode(dir, ["node", "kit", "agent-config", "--portable-gates"]), true);
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      settingsWith('"$HOME/.kit/bin/kit" gate-bash'),
    );
    assert.equal(holdsPortableGate(dir), false);
    writeFileSync(join(dir, ".claude", "settings.json"), settingsWith(LINE));
    assert.equal(portableGatesMode(dir, ["node", "kit", "agent-config"]), true);
  });
});

describe(
  "kit agent-config --portable-gates (real CLI)",
  { skip: POSIX ? false : "POSIX sh line" },
  () => {
    it("writes the gates to a tracked settings.json, and a later plain run keeps them there", (t) => {
      const dir = temp(t, "kit-portable-cli-");
      const home = temp(t, "kit-portable-clihome-");
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, ".claude", "settings.json"), "{}\n");
      writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
      const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
      git("init", "-q", ".");
      git("add", "-A");
      git("-c", "user.email=a@example.invalid", "-c", "user.name=a", "commit", "-qm", "init");
      const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [cli, "agent-config", ...args], {
          cwd: dir,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: home,
            KIT_NO_UPDATE_CHECK: "1",
            KIT_HIDE_HOOK_SKIP_BANNER: "1",
          },
          timeout: 120_000,
        });
      const gates = () =>
        kitGateCommands(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));

      const first = run("--portable-gates");
      assert.match(first.stdout, /portable gates: \.claude\/settings\.json holds gate lines/);
      assert.deepEqual(gates(), [
        portableGateCommand("gate-bash"),
        portableGateCommand("gate-env"),
      ]);
      assert.equal(existsSync(join(dir, ".claude", "settings.local.json")), false);

      run();
      assert.deepEqual(gates(), [
        portableGateCommand("gate-bash"),
        portableGateCommand("gate-env"),
      ]);
      assert.equal(existsSync(join(dir, ".claude", "settings.local.json")), false);
    });
  },
);
