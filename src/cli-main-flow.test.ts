/**
 * Characterization tests for `main()` in cli.ts. They pin the branches of the dispatcher that
 * no other test reaches, before the function is split into helpers: the invalid read-only flag,
 * completions, the unknown-command message with and without a suggestion, the error report for a
 * missing configuration, the refusal on an invalid configuration (exit 1, and exit 2 for a gate
 * verb) and the read-only floor from the environment and from `[policy] default_mode`.
 *
 * Each run uses a disposable HOME and a disposable git repo. The suite skips on win32.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliResult } from "./cli-run.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const skip = process.platform === "win32" ? "fixtures need a POSIX layout" : false;

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Fixture {
  dir: string;
  home: string;
}

let f: Fixture;
function useFixture(): void {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "kit-main-char-"));
    const dir = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(dir);
    mkdirSync(home);
    execFileSync("git", ["init", "-q", dir]);
    f = { dir, home };
  });
  afterEach(() => {
    rmTemp(join(f.dir, ".."));
  });
}

async function kit(
  args: string[],
  env: Record<string, string> = {},
): Promise<CliResult & { out: string }> {
  const r = await runCli(args, f.dir, {
    HOME: f.home,
    USERPROFILE: f.home,
    KIT_WRAPPER_ALLOW_DEV: "1",
    ...env,
  });
  return { ...r, out: plain(r.stdout + r.stderr) };
}

describe("main: flags and completions", { skip }, () => {
  useFixture();

  it("rejects a read-only flag with a value that is not truthy, exit 2", async () => {
    const r = await kit(["check", "--read-only=maybe"]);
    assert.equal(r.exitCode, 2);
    assert.match(
      r.out,
      /invalid value for --read-only: "maybe" \(expected no value, or a truthy value/,
    );
  });

  it("prints a completion script for a known shell, exit 0", async () => {
    const r = await kit(["completions", "bash"]);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /^# kit bash completion/);
  });

  it("refuses an unknown shell, exit 1, and writes nothing to stdout", async () => {
    const r = await kit(["completions", "powershell"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /Unknown shell: powershell\. Use: bash, zsh, fish/);
    assert.equal(r.stdout, "");
  });

  it("names the missing shell argument as undefined", async () => {
    const r = await kit(["completions"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /Unknown shell: undefined\./);
  });
});

describe("main: unknown command", { skip }, () => {
  useFixture();

  it("suggests the closest command, exit 1", async () => {
    const r = await kit(["statu"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /Unknown command: statu/);
    assert.match(r.out, /Did you mean: 'status'\?/);
    assert.match(r.out, /Run 'kit help' for a list of available commands\./);
  });

  it("gives no suggestion when nothing is close, exit 1", async () => {
    const r = await kit(["zzzzqq"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /Unknown command: zzzzqq/);
    assert.doesNotMatch(r.out, /Did you mean/);
    assert.match(r.out, /Run 'kit help' for a list of available commands\./);
  });
});

describe("main: configuration errors", { skip }, () => {
  useFixture();

  it("reports a missing .kit.toml with the directory and a hint, exit 1", async () => {
    const r = await kit(["check"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /Error: \.kit\.toml not found in /);
    assert.match(
      r.stderr,
      /Create a \.kit\.toml to define your project's tools, services, and secrets\./,
    );
  });

  it("emits a JSON error on stdout for a missing .kit.toml with --json", async () => {
    const r = await kit(["check", "--json"]);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n")[0] ?? ""), {
      ok: false,
      error: ".kit.toml not found",
    });
  });

  it("refuses to dispatch on an invalid .kit.toml, exit 1", async () => {
    writeFileSync(join(f.dir, ".kit.toml"), "x = = =\n");
    const r = await kit(["check"]);
    assert.equal(r.exitCode, 1);
    assert.match(
      r.stderr,
      /Could not read or validate project configuration\. Check \.kit\.toml\./,
    );
  });

  it("refuses a gate verb on an invalid .kit.toml with exit 2", async () => {
    writeFileSync(join(f.dir, ".kit.toml"), "x = = =\n");
    const r = await kit(["gate-env"]);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /Could not read or validate project configuration\./);
  });

  it("puts the refusal in JSON on stdout when --json is given", async () => {
    writeFileSync(join(f.dir, ".kit.toml"), "x = = =\n");
    const r = await kit(["check", "--json"]);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n")[0] ?? ""), {
      ok: false,
      error: "Could not read or validate project configuration. Check .kit.toml.",
    });
  });
});

describe("main: read-only floor", { skip }, () => {
  useFixture();

  it("refuses a write verb when KIT_READ_ONLY is set, exit 1, and writes nothing", async () => {
    const r = await kit(["policy", "init"], { KIT_READ_ONLY: "1" });
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /✗ /);
    assert.equal(existsSync(join(f.dir, ".kit-policy.toml")), false);
  });

  it("refuses a write verb with the --read-only flag, exit 1", async () => {
    const r = await kit(["policy", "init", "--read-only"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /✗ /);
  });

  it("refuses a write verb when the policy default_mode is read-only", async () => {
    writeFileSync(join(f.dir, ".kit.toml"), '[policy]\ndefault_mode = "read-only"\n');
    const r = await kit(["policy", "init"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /✗ /);
  });
});
