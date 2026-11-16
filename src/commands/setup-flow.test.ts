/**
 * Characterization tests for `kit setup` (cmdSetup). They pin the command's observable flow
 * before the function is split into helpers: mode selection, which steps run in which mode,
 * the .gitignore hardening, migrate/seed gating, the recommended hardening block and the
 * final verdict.
 *
 * Known defects the tests do not pin (a refactor must not change behavior): `kit setup`
 * passes its own flags on to `kit check`, which rejects them, so a run with --mode=, --minimal,
 * --recommended or --with-migrate ends with "unknown flag for kit check" and exit 1. The tests
 * that use those flags therefore check the printed steps only, not the exit code.
 *
 * Each run uses a disposable HOME and a disposable git repo, so no real ~/.claude file changes.
 * The suite skips on win32: the configured commands are `true` and `false` from a POSIX shell.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, GITIGNORE_CONTENT, type CliResult } from "../cli-run.test-support.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const skip = process.platform === "win32" ? "configured commands need a POSIX shell" : false;

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, "");

const BASE_TOML = `[secrets]
store = "env"

[secrets.keys]
APP_NAME = { source = "config", value = "my-app" }
`;

interface Fixture {
  dir: string;
  home: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "kit-setup-char-"));
  const dir = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(dir);
  mkdirSync(home);
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE_CONTENT);
  writeFileSync(join(dir, ".kit.toml"), BASE_TOML);
  return { dir, home };
}

function setup(f: Fixture, args: string[]): Promise<CliResult> {
  return runCli(["setup", ...args], f.dir, {
    HOME: f.home,
    USERPROFILE: f.home,
    KIT_WRAPPER_ALLOW_DEV: "1",
  });
}

function toml(f: Fixture, extra: string): void {
  writeFileSync(join(f.dir, ".kit.toml"), BASE_TOML + extra);
}

/** The step headings that appear in the output, in order. */
function steps(out: string): string[] {
  return plain(out).match(/\[(?:\d\/6|\+)\][^\n]*/g) ?? [];
}

/** Only the step tags, such as "[5/6]" or "[+]". */
function stepIds(out: string): string[] {
  return steps(out).map((s) => s.slice(0, s.indexOf("]") + 1));
}

let f: Fixture;
function useFixture(): void {
  beforeEach(() => {
    f = makeFixture();
  });
  afterEach(() => {
    rmTemp(join(f.dir, ".."));
  });
}

describe("kit setup: modes", { skip }, () => {
  useFixture();

  it("an unknown --mode warns and falls back to full", async () => {
    const r = await setup(f, ["--mode=bogus"]);
    const out = plain(r.stdout);
    assert.match(out, /unknown mode "bogus" — using "full"\. Modes: /);
    assert.match(out, /mode: full/);
    assert.match(out, /\[1\/6\] Install/);
  });

  it("--mode review is read-only: no install, login or secrets step", async () => {
    const r = await setup(f, ["--mode=review"]);
    const out = plain(r.stdout);
    assert.match(out, /mode: review/);
    assert.match(out, /read-only review — no installs \/ logins \/ secrets \/ hooks\./);
    assert.deepEqual(stepIds(r.stdout), ["[5/6]", "[6/6]"]);
  });

  it("--mode agent skips install and login but runs secrets", async () => {
    const r = await setup(f, ["--mode=agent"]);
    const found = stepIds(r.stdout);
    assert.deepEqual(found, ["[4/6]", "[5/6]", "[6/6]", "[+]"]);
  });

  it("--mode ci skips login and git hooks", async () => {
    const r = await setup(f, ["--mode=ci"]);
    const found = stepIds(r.stdout);
    assert.deepEqual(found, ["[1/6]", "[4/6]", "[5/6]", "[6/6]"]);
  });

  it("[setup].mode in the config picks the mode when no flag is given", async () => {
    toml(f, '\n[setup]\nmode = "review"\n');
    const r = await setup(f, []);
    assert.match(plain(r.stdout), /mode: review/);
  });
});

describe("kit setup: the core steps", { skip }, () => {
  useFixture();

  it("a plain run executes the steps in order, then hardening, and ends with the success line", async () => {
    const r = await setup(f, []);
    const found = stepIds(r.stdout);
    assert.deepEqual(found, ["[1/6]", "[3/6]", "[4/6]", "[5/6]", "[6/6]", "[+]"]);
    assert.match(plain(r.stdout), /Setup complete — you're ready to go! ✓/);
    assert.equal(r.exitCode, 0, r.stderr);
  });

  it("hardens a .gitignore that lacks the secret patterns before secrets run", async () => {
    writeFileSync(join(f.dir, ".gitignore"), "node_modules\n");
    const r = await setup(f, ["--mode=local"]);
    const out = plain(r.stdout);
    const hardened = out.indexOf("hardened .gitignore");
    assert.ok(hardened > out.indexOf("[4/6] Secrets"), "announced inside the secrets step");
    assert.match(out, /hardened \.gitignore \(\+\d+: /);
    assert.match(readFileSync(join(f.dir, ".gitignore"), "utf-8"), /\.env\.local/);
  });

  it("a second run finds the .gitignore already hardened", async () => {
    await setup(f, ["--mode=local"]);
    const r = await setup(f, ["--mode=local"]);
    assert.doesNotMatch(plain(r.stdout), /hardened \.gitignore/);
  });

  it("runs the agent-config step and reports each agent file", async () => {
    const r = await setup(f, ["--mode=local"]);
    const out = plain(r.stdout);
    const afterStep5 = out.slice(out.indexOf("[5/6] Agent config"), out.indexOf("[6/6]"));
    assert.match(afterStep5, /(created|updated|unchanged)/);
  });
});

describe("kit setup: configured commands", { skip }, () => {
  useFixture();

  it("runs [setup].install after the toolchain install", async () => {
    toml(f, '\n[setup]\ninstall = "true"\n');
    const r = await setup(f, ["--mode=local"]);
    const out = plain(r.stdout);
    assert.match(out, /\$ true\n\s+✓ deps installed/);
    assert.ok(out.indexOf("deps installed") < out.indexOf("[3/6] Login"));
  });

  it("skips migrate and seed by default and names the command", async () => {
    toml(f, '\n[setup]\nmigrate = "true"\nseed = "true"\n');
    const r = await setup(f, ["--mode=local"]);
    const out = plain(r.stdout);
    assert.match(
      out,
      /Skipping migrate\/seed \(may mutate a real DB\)\. Run deliberately: true {2}· {2}true/,
    );
    assert.match(out, /kit setup --with-migrate/);
    assert.doesNotMatch(out, /\[\+\] Migrate \/ seed/);
  });

  it("--with-migrate runs migrate and then seed", async () => {
    toml(f, '\n[setup]\nmigrate = "true"\nseed = "true"\n');
    const r = await setup(f, ["--mode=local", "--with-migrate"]);
    const out = plain(r.stdout);
    assert.match(out, /\[\+\] Migrate \/ seed/);
    assert.match(out, /✓ migrate/);
    assert.match(out, /✓ seed/);
    assert.ok(out.indexOf("✓ migrate") < out.indexOf("✓ seed"));
  });

  it("a failing [setup].verify prints the issues line and exits 1", async () => {
    toml(f, '\n[setup]\nverify = "false"\n');
    const r = await setup(f, []);
    const out = plain(r.stdout);
    assert.match(out, /\[\+\] Verify build/);
    assert.match(out, /✗ false \(exit 1\)/);
    assert.match(out, /Setup finished with issues\. Run kit check to see what's left\./);
    assert.equal(r.exitCode, 1);
  });

  it("a failing [setup].install is reported but does not stop setup or change the verdict", async () => {
    toml(f, '\n[setup]\ninstall = "false"\n');
    const r = await setup(f, []);
    const out = plain(r.stdout);
    assert.match(out, /✗ deps installed \(exit 1\)/);
    assert.match(out, /\[6\/6\] Verify/);
    assert.match(out, /Setup complete — you're ready to go! ✓/);
  });
});

describe("kit setup: recommended profile", { skip }, () => {
  useFixture();

  it("the full mode adds the hardening block after verify", async () => {
    const r = await setup(f, []);
    const out = plain(r.stdout);
    assert.match(out, /Recommended profile on — memory \+ git hooks wired after the core steps\./);
    assert.ok(out.indexOf("[6/6] Verify") < out.indexOf("[+] Recommended hardening"));
  });

  it("--minimal and --no-recommended leave the hardening block out", async () => {
    for (const flag of ["--minimal", "--no-recommended"]) {
      const r = await setup(f, [flag]);
      const out = plain(r.stdout);
      assert.doesNotMatch(out, /Recommended hardening/, flag);
      assert.doesNotMatch(out, /Recommended profile on/, flag);
    }
  });

  it("--recommended turns the hardening block on in a mode that defaults it off", async () => {
    const r = await setup(f, ["--mode=local", "--recommended"]);
    assert.match(plain(r.stdout), /\[\+\] Recommended hardening/);
  });

  it("a non-interactive run without a flag follows the mode's default", async () => {
    const r = await setup(f, ["--mode=ci"]);
    assert.doesNotMatch(plain(r.stdout), /Recommended hardening/);
  });
});
