import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  DESKTOP_ACTIONS,
  DESKTOP_CONFIG_PATH,
  validateDesktopConfig,
} from "./monkey-test-desktop-config.js";

function base(): Record<string, unknown> {
  return {
    startCommand: "bun run tauri dev",
    dataDirEnv: "APP_DATA_DIR",
    hookDirEnv: "APP_HOOK_DIR",
    realDataDirs: ["/abs/data"],
    dataFiles: ["**/*.json"],
    records: "return [];",
    operations: [{ name: "export", start: "return 1;", outcome: "return 'done';" }],
  };
}

it("exposes the config path and the five lifecycle actions", () => {
  assert.equal(DESKTOP_CONFIG_PATH, ".kit/monkey-test/desktop.json");
  assert.deepEqual([...DESKTOP_ACTIONS], ["close-window", "quit", "kill", "reload", "restart"]);
});

it("applies defaults to a minimal config", () => {
  const config = validateDesktopConfig(base());
  assert.equal(config.startTimeoutMs, 300_000);
  assert.equal(config.stepTimeoutMs, 60_000);
  assert.equal(config.operationTimeoutMs, 120_000);
  assert.deepEqual(config.realDataIgnore, []);
  assert.deepEqual(config.logCrashPatterns, []);
  assert.equal(config.seedCommand, undefined);
  assert.match(config.ready, /document\.body/);
  assert.match(config.closeWindow, /window\.close/);
});

it("keeps explicit values", () => {
  const config = validateDesktopConfig({
    ...base(),
    seedCommand: "seed.sh",
    ready: "return true;",
    closeWindow: "return 'x';",
    realDataIgnore: ["models"],
    logCrashPatterns: ["boom"],
    startTimeoutMs: 5,
  });
  assert.equal(config.seedCommand, "seed.sh");
  assert.equal(config.ready, "return true;");
  assert.equal(config.closeWindow, "return 'x';");
  assert.deepEqual(config.realDataIgnore, ["models"]);
  assert.deepEqual(config.logCrashPatterns, ["boom"]);
  assert.equal(config.startTimeoutMs, 5);
});

it("expands ~/ in realDataDirs", () => {
  const config = validateDesktopConfig({ ...base(), realDataDirs: ["~/appdata"] });
  assert.equal(config.realDataDirs[0], join(homedir(), "appdata"));
});

it("rejects relative realDataDirs", () => {
  assert.throws(
    () => validateDesktopConfig({ ...base(), realDataDirs: ["relative/dir"] }),
    /absolute paths or start with ~\/ \(relative\/dir\)/,
  );
});

it("rejects non-objects", () => {
  assert.throws(() => validateDesktopConfig(null), /must be a JSON object/);
  assert.throws(() => validateDesktopConfig("x"), /must be a JSON object/);
});

it("rejects a missing or blank startCommand", () => {
  assert.throws(() => validateDesktopConfig({ ...base(), startCommand: "  " }), /startCommand/);
  assert.throws(
    () => validateDesktopConfig({ ...base(), startCommand: undefined }),
    /startCommand/,
  );
});

it("rejects bad env variable names", () => {
  assert.throws(() => validateDesktopConfig({ ...base(), dataDirEnv: "lower" }), /dataDirEnv/);
  assert.throws(() => validateDesktopConfig({ ...base(), hookDirEnv: "1BAD" }), /hookDirEnv/);
});

it("rejects equal data and hook env names", () => {
  assert.throws(
    () => validateDesktopConfig({ ...base(), hookDirEnv: "APP_DATA_DIR" }),
    /must differ/,
  );
});

it("rejects empty operations and operations missing fields", () => {
  assert.throws(() => validateDesktopConfig({ ...base(), operations: [] }), /at least one/);
  assert.throws(
    () => validateDesktopConfig({ ...base(), operations: [{ name: "a", start: "b" }] }),
    /operations\[0\]\.outcome/,
  );
  assert.throws(() => validateDesktopConfig({ ...base(), operations: [null] }), /operations\[0\]/);
});

it("rejects empty dataFiles and non-string list entries", () => {
  assert.throws(() => validateDesktopConfig({ ...base(), dataFiles: [] }), /dataFiles/);
  assert.throws(() => validateDesktopConfig({ ...base(), dataFiles: [3] }), /dataFiles\[0\]/);
});

it("rejects non-positive and non-integer timeouts", () => {
  for (const bad of [0, -1, 1.5, "10"]) {
    assert.throws(
      () => validateDesktopConfig({ ...base(), stepTimeoutMs: bad }),
      /stepTimeoutMs must be a positive integer/,
    );
  }
});
