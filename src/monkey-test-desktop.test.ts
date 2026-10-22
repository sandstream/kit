import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  DESKTOP_ACTIONS,
  checkDataFiles,
  fingerprintDirs,
  interruptionSchedule,
  matchesDataGlob,
  runDesktopMonkey,
  validateDesktopConfig,
  type DesktopRunResult,
} from "./monkey-test-desktop.js";
import { fakeDesktopRepo, type FakeDesktopMode } from "./monkey-test-desktop.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmTemp(roots.pop()!);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-monkey-desktop-unit-"));
  roots.push(dir);
  return dir;
}

const validConfig = {
  startCommand: "bun run tauri dev",
  dataDirEnv: "APP_DATA_DIR",
  hookDirEnv: "APP_DEBUG_DIR",
  realDataDirs: ["~/Library/Application Support/App"],
  dataFiles: ["meetings/*.json", "settings.json"],
  records: "return []",
  operations: [{ name: "AI summary", start: "return 'ok'", outcome: "return 'done'" }],
};

describe("desktop monkey config", () => {
  it("accepts a complete config and expands ~ in real data folders", () => {
    const config = validateDesktopConfig(validConfig);
    assert.equal(config.realDataDirs[0], join(homedir(), "Library/Application Support/App"));
    assert.equal(config.startTimeoutMs, 300_000);
  });

  it("names every missing or unsafe field", () => {
    assert.throws(() => validateDesktopConfig({}), /startCommand/);
    assert.throws(
      () => validateDesktopConfig({ ...validConfig, dataDirEnv: "lower case" }),
      /dataDirEnv/,
    );
    assert.throws(
      () => validateDesktopConfig({ ...validConfig, realDataDirs: [] }),
      /realDataDirs/,
    );
    assert.throws(
      () => validateDesktopConfig({ ...validConfig, realDataDirs: ["relative/dir"] }),
      /absolute/,
    );
    assert.throws(() => validateDesktopConfig({ ...validConfig, dataFiles: [] }), /dataFiles/);
    assert.throws(() => validateDesktopConfig({ ...validConfig, operations: [] }), /operations/);
    assert.throws(
      () => validateDesktopConfig({ ...validConfig, operations: [{ name: "x", start: "" }] }),
      /operations\[0\]/,
    );
    assert.throws(
      () => validateDesktopConfig({ ...validConfig, hookDirEnv: validConfig.dataDirEnv }),
      /differ/,
    );
  });
});

describe("desktop monkey data checks", () => {
  it("matches data globs with * inside one folder and ** across folders", () => {
    assert.equal(matchesDataGlob("meetings/a.json", "meetings/*.json"), true);
    assert.equal(matchesDataGlob("meetings/2026/a.json", "meetings/*.json"), false);
    assert.equal(matchesDataGlob("meetings/2026/a.json", "meetings/**/*.json"), true);
    assert.equal(matchesDataGlob("settings.json", "settings.json"), true);
    assert.equal(matchesDataGlob("settings.json.bak", "settings.json"), false);
  });

  it("reports every app-owned file that does not parse, and ignores files outside the globs", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "meetings"));
    writeFileSync(join(dir, "meetings", "ok.json"), '{"id":1}');
    writeFileSync(join(dir, "meetings", "torn.json"), '{"id":1,"segm');
    writeFileSync(join(dir, "meetings", "empty.json"), "");
    writeFileSync(join(dir, "events.jsonl"), '{"a":1}\n{"b":\n');
    writeFileSync(join(dir, "notes.txt"), "{not json");
    const result = checkDataFiles(dir, ["meetings/*.json", "*.jsonl"]);
    assert.deepEqual(result.files.sort(), [
      "events.jsonl",
      "meetings/empty.json",
      "meetings/ok.json",
      "meetings/torn.json",
    ]);
    assert.deepEqual(result.corrupt.map((entry) => entry.file).sort(), [
      "events.jsonl",
      "meetings/empty.json",
      "meetings/torn.json",
    ]);
  });

  it("fingerprints folders so any added, removed, or rewritten file shows", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.json"), "1");
    const missing = join(dir, "missing");
    const before = fingerprintDirs([dir, missing], []);
    assert.deepEqual(fingerprintDirs([dir, missing], []), before);
    writeFileSync(join(dir, "b.json"), "2");
    assert.notDeepEqual(fingerprintDirs([dir, missing], []), before);
    const ignored = fingerprintDirs([dir], ["models"]);
    mkdirSync(join(dir, "models"));
    writeFileSync(join(dir, "models", "big.bin"), "x");
    assert.deepEqual(fingerprintDirs([dir], ["models"]), ignored);
  });
});

describe("desktop monkey schedule", () => {
  it("draws interruptions from the run seed, so a seed reproduces the run", () => {
    const options = { steps: 100, interruptions: 5, operations: 2, actions: DESKTOP_ACTIONS };
    const first = interruptionSchedule(42, options);
    assert.deepEqual(interruptionSchedule(42, options), first);
    assert.notDeepEqual(interruptionSchedule(43, options), first);
    assert.equal(first.length, 5);
    assert.equal(new Set(first.map((entry) => entry.step)).size, 5);
    for (const entry of first) {
      assert.ok(entry.step >= 1 && entry.step < 100);
      assert.ok(DESKTOP_ACTIONS.includes(entry.action));
      assert.ok(entry.operation === 0 || entry.operation === 1);
    }
  });

  it("covers every lifecycle action", () => {
    assert.deepEqual([...DESKTOP_ACTIONS].sort(), [
      "close-window",
      "kill",
      "quit",
      "reload",
      "restart",
    ]);
  });
});

const posixOnly = {
  skip:
    process.platform === "win32"
      ? "the driver stops the app by POSIX process group; Windows process trees are not verified"
      : false,
  timeout: 120_000,
};

async function runFake(
  mode: FakeDesktopMode,
  options: Partial<Parameters<typeof runDesktopMonkey>[1]> = {},
): Promise<{ result: DesktopRunResult; realDir: string }> {
  const repo = fakeDesktopRepo(mode);
  roots.push(repo.root);
  const result = await runDesktopMonkey(repo.root, {
    steps: 12,
    seed: 7,
    interruptions: 2,
    delayMs: [50, 300],
    pauseMs: 10,
    ...options,
  });
  return { result, realDir: repo.realDir };
}

function titles(result: DesktopRunResult): string[] {
  return result.findings.map((finding) => finding.title);
}

describe("desktop monkey run against a fake app", () => {
  it("passes a well-behaved app through every lifecycle action", posixOnly, async () => {
    const { result } = await runFake("good", {
      interruptions: DESKTOP_ACTIONS.length,
      steps: 20,
      actions: DESKTOP_ACTIONS,
    });
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
    assert.equal(result.interruptions.length, DESKTOP_ACTIONS.length);
    assert.deepEqual(
      result.interruptions.map((entry) => entry.action).sort(),
      [...DESKTOP_ACTIONS].sort(),
      "five interruptions cover all five actions",
    );
    for (const entry of result.interruptions) {
      assert.match(entry.outcome, /^(done|interrupted)$/, JSON.stringify(entry));
    }
    assert.equal(result.keptDataDir, undefined, "temporary data folder removed on success");
  });

  it("finds a record half-written when the app is killed mid-save", posixOnly, async () => {
    const { result } = await runFake("torn", { actions: ["kill"] });
    assert.equal(result.ok, false);
    assert.ok(
      titles(result).includes("Half-saved or corrupt data file"),
      titles(result).join("\n"),
    );
    assert.ok(result.keptDataDir && existsSync(result.keptDataDir), "data kept for the repro");
    const corrupt = result.findings.find((f) => f.title === "Half-saved or corrupt data file")!;
    assert.match(corrupt.repro, /--seed 7/);
  });

  it("finds an interrupted operation that vanished without a message", posixOnly, async () => {
    const { result } = await runFake("silent", { actions: ["quit"] });
    assert.ok(
      titles(result).includes("Interrupted operation lost without a message"),
      titles(result).join("\n"),
    );
    const lost = result.findings.find(
      (f) => f.title === "Interrupted operation lost without a message",
    )!;
    assert.match(lost.route, /quit during AI summary/);
  });

  it("finds a close-window that quits the app and loses the operation", posixOnly, async () => {
    const { result } = await runFake("silent", { actions: ["close-window"] });
    assert.ok(titles(result).includes("Interrupted operation lost without a message"));
  });

  it(
    "keeps an app running that asks before it closes, so the work can finish",
    posixOnly,
    async () => {
      const { result } = await runFake("keepalive", { actions: ["close-window"] });
      assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
      assert.deepEqual(
        result.interruptions.map((entry) => [entry.outcome, entry.restarted]),
        [
          ["done", false],
          ["done", false],
        ],
        "the driver did not kill the app behind its dialog",
      );
    },
  );
});

describe("desktop monkey run: safety, crashes, and reproduction", () => {
  it("finds writes to the real data folder", posixOnly, async () => {
    const { result } = await runFake("realdir", { interruptions: 0 });
    assert.ok(titles(result).includes("Real data folder changed during the run"));
  });

  it("finds a crash in the app log after a restart", posixOnly, async () => {
    const { result } = await runFake("panic", { actions: ["restart"] });
    assert.ok(titles(result).includes("App log shows a crash"), titles(result).join("\n"));
  });

  it("finds an uncaught page error from a random click", posixOnly, async () => {
    const { result } = await runFake("crash", { interruptions: 0, steps: 30 });
    assert.ok(titles(result).includes("Page error"), titles(result).join("\n"));
    assert.equal(
      titles(result).filter((title) => title === "Page error").length,
      1,
      "one cause is reported once, with the steps that led to it",
    );
    const pageError = result.findings.find((finding) => finding.title === "Page error")!;
    assert.match(pageError.repro, /last steps: .*New record/);
  });

  it("reproduces the same actions from the same seed", posixOnly, async () => {
    const first = (await runFake("good", { seed: 99 })).result;
    const second = (await runFake("good", { seed: 99 })).result;
    const shape = (result: DesktopRunResult) =>
      result.interruptions.map(({ step, operation, action }) => ({ step, operation, action }));
    assert.deepEqual(shape(second), shape(first));
    assert.deepEqual(second.actions, first.actions);
  });

  it("refuses to start without a valid config", async () => {
    const dir = tempDir();
    const result = await runDesktopMonkey(dir, { steps: 1 });
    assert.equal(result.ok, false);
    assert.deepEqual(titles(result), ["Desktop monkey config missing or invalid"]);
  });
});
