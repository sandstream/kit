import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

const source = import.meta.url.endsWith(".ts");
const cli = fileURLToPath(new URL(source ? "./cli.ts" : "./cli.js", import.meta.url));
const loader = source ? ["--import", import.meta.resolve("tsx")] : [];

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [
        relative(root, path),
        entry.isDirectory() ? "directory" : readFileSync(path).toString("base64"),
      ];
    }),
  );
}

function run(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [...loader, cli, ...args], {
    cwd,
    env,
    encoding: "utf8",
    input,
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

/** Exercise the real CLI without personal configuration, credentials, or provider clients. */
export function createCliContractFixture(config = "version = 1\n") {
  const root = mkdtempSync(join(tmpdir(), "kit-cli-contract-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  // Windows creates the profile folders under USERPROFILE when a process first resolves them.
  // Create them up front so a snapshot taken before the first CLI run matches one taken after it.
  const roaming = join(home, "AppData", "Roaming");
  const local = join(home, "AppData", "Local");
  mkdirSync(roaming, { recursive: true });
  mkdirSync(local, { recursive: true });
  writeFileSync(join(cwd, ".kit.toml"), config);
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath),
    HOME: home,
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    SystemRoot: process.env.SystemRoot,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    CI: "true",
    NO_COLOR: "1",
    TSX_DISABLE_CACHE: "1",
    KIT_NON_INTERACTIVE: "1",
    KIT_NO_UPDATE_CHECK: "1",
    KIT_AUDIT_ANCHOR: "0",
    KIT_KEYSTORE: "file",
    KIT_DEFAULTS_FILE: join(home, "defaults.toml"),
    KIT_AUDIT_ANCHOR_DIR: join(home, "anchors"),
    KIT_IDENTITY_DIR: join(home, "identity"),
    KIT_MEMORY_DIR: join(home, "memory"),
    KIT_MEMORY_DB: join(home, "memory.db"),
    KIT_SYNTHETIC_VALUE: "public-fixture-value",
  };
  return {
    root,
    cwd,
    env,
    run: (args: string[], input?: string) => run(cwd, env, args, input),
    snapshot: () => snapshot(root),
    cleanup: () => rmTemp(root),
  };
}
