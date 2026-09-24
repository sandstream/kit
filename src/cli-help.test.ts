import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMAND_HELP } from "./cli.js";

const source = import.meta.url.endsWith(".ts");
const cli = fileURLToPath(new URL(source ? "./cli.ts" : "./cli.js", import.meta.url));
const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
const networkGuard = `data:text/javascript,${encodeURIComponent(`
  import { appendFileSync } from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import http from "node:http";
  import https from "node:https";
  const refuse = () => {
    appendFileSync(process.env.KIT_HELP_PROVIDER_LOG, "HTTP provider call\\n");
    throw new Error("Help must not contact a provider");
  };
  globalThis.fetch = refuse;
  http.request = http.get = https.request = https.get = refuse;
  syncBuiltinESMExports();
`)}`;

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path, entry.isDirectory() ? "directory" : readFileSync(path).toString("base64")];
    }),
  );
}

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kit-cli-help-"));
  cwd = join(root, "project");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [cwd, home, bin]) mkdirSync(dir);
  writeFileSync(join(cwd, ".kit.toml"), '[secrets]\nstore = "infisical"\n');
  writeFileSync(join(cwd, "CLAUDE.md"), "Existing project instructions.\n");
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
  // Any provider/tool invocation leaves evidence inside the snapshotted tree.
  for (const tool of ["infisical", "vercel", "gh", "mise", "git"]) {
    writeFileSync(
      join(bin, tool),
      '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$KIT_HELP_PROVIDER_LOG"\nexit 97\n',
      { mode: 0o755 },
    );
  }
  env = {
    PATH: [bin, dirname(process.execPath)].join(delimiter),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    SystemRoot: process.env.SystemRoot,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    CI: "true",
    NO_COLOR: "1",
    TSX_DISABLE_CACHE: "1",
    KIT_NON_INTERACTIVE: "1",
    KIT_BUMBLEBEE: "0",
    KIT_NO_FAILURE_SIM: "1",
    KIT_NO_UPDATE_CHECK: "1",
    KIT_AUDIT_ANCHOR: "0",
    KIT_HIDE_HOOK_SKIP_BANNER: "1",
    KIT_MEMORY_DB: join(home, "memory.db"),
    KIT_MEMORY_DIR: join(home, "memory"),
    KIT_IDENTITY_DIR: join(home, "identity"),
    KIT_CLAUDE_SETTINGS: join(home, "claude-settings.json"),
    KIT_CODEX_HOOKS: join(home, "codex-hooks.json"),
    KIT_MEMORY_HOOK_MARKER: join(home, "claude-marker"),
    KIT_CODEX_MEMORY_HOOK_MARKER: join(home, "codex-marker"),
    KIT_HELP_PROVIDER_LOG: join(root, "provider-calls.log"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[], status = 0): string {
  const before = snapshot(root);
  const result = spawnSync(process.execPath, [...loader, "--import", networkGuard, cli, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.deepEqual(snapshot(root), before, `kit ${args.join(" ")} changed fixture state`);
  return result.stdout;
}

for (const args of [
  ["memory", "--help"],
  ["help", "memory"],
]) {
  it(`kit ${args.join(" ")} lists registered memory subcommands and usage`, () => {
    const out = run(args);
    assert.match(out, /Subcommands:/);
    assert.match(out, /kit memory search/);
    assert.match(out, /kit memory backup/);
    assert.match(out, /kit memory pal configure/);
    for (const flag of ["--manual", "--verify-file", "--verify-http", "--expect"]) {
      assert.ok(out.includes(flag), `configure usage must expose ${flag}`);
    }
    for (const [command, help] of Object.entries(COMMAND_HELP)) {
      if (command.startsWith("memory ")) assert.ok(out.includes(`kit ${command} \u2014 ${help}`));
    }
    assert.doesNotMatch(out, /kit secrets sync/);
  });
}

for (const args of [
  ["memory", "pal", "configure", "--help"],
  ["help", "memory", "pal", "configure"],
  ["help", "memory pal configure"],
]) {
  it(`kit ${args.join(" ")} resolves nested help`, () => {
    const out = run(args);
    assert.match(out, /^kit memory pal configure /);
    assert.match(out, /--manual/);
    assert.match(out, /--verify-file <path>/);
    assert.match(out, /--verify-http <url> \[--expect <code>\]/);
    assert.doesNotMatch(out, /kit memory search/);
  });
}

it("lists generic registry subcommands and preserves declared usage", () => {
  const out = run(["secrets", "--help"]);
  assert.match(out, /Subcommands:/);
  assert.ok(out.includes(`kit secrets set \u2014 ${COMMAND_HELP["secrets set"]}`));
  assert.match(out, /--stdin/);
  assert.match(out, /--value <v>/);
  assert.doesNotMatch(out, /kit memory search/);
});

it("resolves a generic leaf and flag-shaped registry entries", () => {
  assert.ok(run(["secrets", "set", "API_KEY", "--help"]).startsWith("kit secrets set "));
  assert.ok(run(["help", "secrets", "set"]).startsWith("kit secrets set "));
  assert.ok(run(["setup", "--recommended", "--help"]).startsWith("kit setup --recommended "));
});

it("keeps top-level, known command, and unknown help semantics", () => {
  const global = run(["--help"]);
  assert.match(global, /Usage:/);
  assert.match(global, /kit <command>/);
  for (const args of [
    ["-h"],
    ["help"],
    ["--help", "memory", "install"],
    ["no-such-command", "--help"],
    ["help", "no-such-command"],
    ["help", "toString"],
    ["memory-unknown", "--help"],
  ]) {
    assert.equal(run(args), global);
  }
  assert.ok(run(["status", "-h"]).startsWith(`kit status \u2014 ${COMMAND_HELP.status}`));
  assert.equal(run(["memory", "no-such-subcommand", "--help"]), run(["memory", "--help"]));
  assert.equal(run(["no-such-command"], 1), "");
});

const mutations = [
  ["agent-config", "--mode", "strict"],
  ["fix", "--force"],
  ["hooks", "add", "secret-scan"],
  ["secrets", "set", "API_KEY", "--value", "fixture-value"],
  ["memory", "install"],
  ["memory", "backup", "backup.enc"],
  [
    "memory",
    "pal",
    "configure",
    "P1",
    "--verify-http",
    "https://example.invalid",
    "--expect",
    "204",
  ],
  ["memory", "pal", "configure", "P1", "--verify-file", "CLAUDE.md"],
  ["memory", "pal", "configure", "P1", "--manual"],
];
for (const args of mutations) {
  it(`help anywhere prevents kit ${args.join(" ")} from mutating`, () => {
    for (const flag of ["--help", "-h"]) {
      for (const index of new Set([0, 1, args.length - 1, args.length])) {
        const out = run([...args.slice(0, index), flag, ...args.slice(index)]);
        assert.match(out, /kit /);
      }
    }
  });
}

it("help stays read-only with global options, unknown flags, and pass-through arguments", () => {
  for (const args of [
    ["--read-only", "memory", "install", "--help"],
    ["memory", "install", "--help", "--read-only"],
    ["--env=staging", "--non-interactive", "memory", "pal", "configure", "P1", "--manual", "-h"],
    ["fix", "--not-a-real-flag", "--help"],
    ["fix", "--read-only=false", "--help"],
    ["run", "--", "touch", "should-not-exist", "--help"],
  ]) {
    assert.match(run(args), /kit /);
  }
});

it("help bypasses configured read-only activation and malformed configuration", () => {
  for (const config of ['[policy]\ndefault_mode = "read-only"\n', "[invalid toml"]) {
    writeFileSync(join(cwd, ".kit.toml"), config);
    assert.match(run(["memory", "install", "--help"]), /^kit memory install /);
    assert.match(run(["help", "memory"]), /^kit memory /);
  }
});
