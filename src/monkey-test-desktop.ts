import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monkeyFinding } from "./monkey-test-contract.js";
import { DesktopApp } from "./monkey-test-desktop-app.js";
import {
  DESKTOP_ACTIONS,
  DESKTOP_CONFIG_PATH,
  validateDesktopConfig,
  type DesktopAction,
  type DesktopConfig,
  type DesktopOperation,
} from "./monkey-test-desktop-config.js";
import { checkDataFiles, fingerprintDirs } from "./monkey-test-desktop-data.js";
import {
  PAGE_CHECK,
  PAGE_HELPERS,
  PAGE_MONITOR,
  pageStep,
  type PageCheck,
} from "./monkey-test-desktop-page.js";
import {
  MAX_FINDINGS,
  interruptionSchedule,
  recordCheck,
  report,
  scanLog,
  seededRandom,
  sleep,
  type DesktopRunResult,
  type RunState,
  type ScheduledInterruption,
} from "./monkey-test-desktop-report.js";
import { runShell } from "./monkey-test-process.js";

export { DESKTOP_ACTIONS, DESKTOP_CONFIG_PATH, validateDesktopConfig };
export type { DesktopAction, DesktopConfig, DesktopOperation };
export { interruptionSchedule, seededRandom } from "./monkey-test-desktop-report.js";
export type {
  DesktopInterruption,
  DesktopRunResult,
  ScheduledInterruption,
} from "./monkey-test-desktop-report.js";
export { checkDataFiles, fingerprintDirs, matchesDataGlob } from "./monkey-test-desktop-data.js";

export interface DesktopRunOptions {
  steps?: number;
  seed?: number;
  interruptions?: number;
  /** Restrict the lifecycle actions, for example to reproduce one finding. */
  actions?: readonly DesktopAction[];
  /** How long an operation runs before it is interrupted, drawn from the seed. */
  delayMs?: [number, number];
  /** Pause between click steps. */
  pauseMs?: number;
  configPath?: string;
}

async function installMonitor(state: RunState): Promise<boolean> {
  const timeout = state.config.stepTimeoutMs;
  for (const script of [PAGE_MONITOR, PAGE_HELPERS]) {
    if (!(await state.app.eval(script, timeout)).ok) return false;
  }
  const canary = await state.app.eval(
    "console.error('kit-monkey-canary'); return JSON.stringify(window.__kitMonkey.errors.splice(0));",
    timeout,
  );
  return canary.ok && String(canary.value).includes("kit-monkey-canary");
}

async function waitReady(state: RunState): Promise<boolean> {
  const deadline = Date.now() + state.config.startTimeoutMs;
  while (Date.now() < deadline) {
    if (!state.app.running()) return false;
    const ready = await state.app.eval(state.config.ready, 3_000);
    if (ready.ok && ready.value) return true;
    await sleep(200);
  }
  return false;
}

/** Starts the app (unless only the page reloaded) and waits until the monitor runs. */
async function bringBack(state: RunState, action: DesktopAction | "start"): Promise<boolean> {
  state.restarted = false;
  if (action === "reload") {
    await sleep(300);
    return (await waitReady(state)) && (await installMonitor(state));
  }
  // An app may stay open after a close, for example behind a "quit anyway?" dialog that
  // protects running work. Keep it running: killing it would turn a protected close into
  // a crash and blame the app for it.
  if (action === "close-window" && state.app.running()) {
    const open = await state.app.eval("return 'ok';", 3_000);
    if (open.ok && (await installMonitor(state))) return true;
  }
  if (state.app.running()) await state.app.stop("SIGTERM", 10_000);
  if (action !== "restart" && action !== "start") await sleep(1_000);
  state.app.start();
  state.restarted = true;
  return (await waitReady(state)) && (await installMonitor(state));
}

async function performAction(state: RunState, action: DesktopAction): Promise<void> {
  const app = state.app;
  if (action === "close-window") {
    await app.eval(state.config.closeWindow, 3_000);
    // Long enough for an app that quits on close to finish its own shutdown.
    await app.waitExit(3_000);
  } else if (action === "reload") {
    await app.eval("window.location.reload(); return 'ok';", 3_000);
  } else {
    await app.stop(action === "kill" ? "SIGKILL" : "SIGTERM", 10_000);
  }
}

async function visibleRecords(state: RunState, route: string): Promise<string[] | null> {
  const answer = await state.app.eval(state.config.records, state.config.stepTimeoutMs);
  if (answer.ok && Array.isArray(answer.value)) return answer.value.map(String);
  report(state, {
    severity: "high",
    area: "runner",
    title: "Records script failed",
    route,
    detail: answer.ok ? `returned ${JSON.stringify(answer.value)}` : answer.message,
    fix: `Make "records" in ${DESKTOP_CONFIG_PATH} return the record labels the UI shows, as an array of strings.`,
    file: DESKTOP_CONFIG_PATH,
  });
  return null;
}

function checkData(state: RunState, route: string, before?: string[]): void {
  const data = checkDataFiles(state.dataDir, state.config.dataFiles);
  for (const { file, error } of data.corrupt) {
    report(state, {
      severity: "critical",
      area: "data",
      title: "Half-saved or corrupt data file",
      route,
      detail: `${file}: ${error}`,
      fix: "Write to a temporary file and rename it over the old one, so a stop never leaves half a record.",
      file,
    });
  }
  for (const file of data.unchecked) {
    report(state, {
      severity: "medium",
      area: "runner",
      title: "Data file type cannot be checked",
      route: "*",
      detail: file,
      fix: "List only JSON, JSON Lines, or TOML files in dataFiles.",
      file: DESKTOP_CONFIG_PATH,
    });
  }
  for (const file of (before ?? []).filter((entry) => !data.files.includes(entry))) {
    report(state, {
      severity: "critical",
      area: "data",
      title: "Data file disappeared after an interruption",
      perRoute: true,
      route,
      detail: file,
      fix: "Never delete or replace a record before its new version is safely on disk.",
      file,
    });
  }
}

async function waitOutcome(state: RunState, operation: DesktopOperation): Promise<string> {
  const deadline = Date.now() + state.config.operationTimeoutMs;
  while (Date.now() < deadline) {
    const answer = await state.app.eval(operation.outcome, state.config.stepTimeoutMs);
    if (!answer.ok) return `outcome script failed: ${answer.message}`;
    const outcome = String(answer.value).trim();
    if (outcome !== "running") return outcome;
    await sleep(250);
  }
  return `still running after ${state.config.operationTimeoutMs} ms`;
}

async function interrupt(state: RunState, planned: ScheduledInterruption): Promise<boolean> {
  const operation = state.config.operations[planned.operation];
  const route = `${planned.action} during ${operation.name} (step ${planned.step})`;
  const recordsBefore = await visibleRecords(state, route);
  const filesBefore = checkDataFiles(state.dataDir, state.config.dataFiles).files;
  const started = await state.app.eval(operation.start, state.config.stepTimeoutMs);
  if (!started.ok) {
    report(state, {
      severity: "high",
      area: "runner",
      title: "Operation could not start",
      route,
      detail: started.message,
      fix: `Make operations[].start in ${DESKTOP_CONFIG_PATH} start "${operation.name}" from any screen.`,
      file: DESKTOP_CONFIG_PATH,
    });
    return true;
  }
  const [min, max] = state.delayMs;
  await sleep(Math.round(min + planned.delay * (max - min)));
  await performAction(state, planned.action);
  scanLog(state, route);
  if (!(await bringBack(state, planned.action))) {
    scanLog(state, route);
    report(state, {
      severity: "critical",
      area: "ux",
      title: "App did not start again after an interruption",
      perRoute: true,
      route,
      detail: "the app did not answer its ready check, or its error monitor did not install",
      fix: "Make startup recover from any state a stop can leave behind.",
    });
    return false;
  }
  await afterRestart(state, { route, operation, planned, recordsBefore, filesBefore });
  return true;
}

interface InterruptionContext {
  route: string;
  operation: DesktopOperation;
  planned: ScheduledInterruption;
  recordsBefore: string[] | null;
  filesBefore: string[];
}

async function afterRestart(state: RunState, context: InterruptionContext): Promise<void> {
  const { route, operation, planned, recordsBefore, filesBefore } = context;
  const check = await state.app.eval(PAGE_CHECK, state.config.stepTimeoutMs);
  if (check.ok) recordCheck(state, JSON.parse(String(check.value)) as PageCheck, route);
  scanLog(state, route);
  checkData(state, route, filesBefore);
  const recordsAfter = recordsBefore ? await visibleRecords(state, route) : null;
  for (const record of (recordsBefore ?? []).filter((r) => !recordsAfter?.includes(r))) {
    report(state, {
      severity: "critical",
      area: "data",
      title: "Data missing after restart",
      perRoute: true,
      route,
      detail: record,
      fix: "The app must show every record it showed before the interruption.",
    });
  }
  const outcome = await waitOutcome(state, operation);
  if (outcome !== "done" && outcome !== "interrupted") {
    report(state, {
      severity: "high",
      area: "data",
      title: "Interrupted operation lost without a message",
      perRoute: true,
      route,
      detail: `outcome: ${outcome}`,
      fix: `Finish "${operation.name}" after the restart, or show the user that it was interrupted and how to run it again.`,
    });
  }
  state.result.interruptions.push({
    step: planned.step,
    operation: operation.name,
    action: planned.action,
    outcome,
    restarted: state.restarted,
  });
}

/** One random click step. False when the run cannot go on. */
async function clickStep(state: RunState, step: number, seed: number): Promise<boolean> {
  const route = `click step ${step}`;
  const answer = await state.app.eval(pageStep(seed), state.config.stepTimeoutMs);
  if (answer.ok) {
    recordCheck(state, JSON.parse(String(answer.value)) as PageCheck, route);
    return true;
  }
  if (answer.reason === "timeout" && state.app.running()) {
    report(state, {
      severity: "critical",
      area: "ux",
      title: "App stopped answering",
      route,
      detail: `${answer.message} | last steps: ${state.result.actions.slice(-5).join(" -> ")}`,
      fix: "Find the blocked thread; the UI must stay responsive during every action.",
    });
    return false;
  }
  // The app quit (a Quit button) or the page navigated away from the monitor.
  scanLog(state, route);
  state.result.steps.push({ name: route, status: "skip", detail: answer.message });
  return bringBack(state, answer.reason === "exited" ? "start" : "reload");
}

async function clickPass(state: RunState): Promise<void> {
  const schedule = interruptionSchedule(state.seed, {
    steps: state.steps,
    interruptions: state.interruptionCount,
    operations: state.config.operations.length,
    actions: state.actions,
  });
  const clicks = seededRandom(state.seed);
  for (let step = 0; step < state.steps; step++) {
    const seed = Math.floor(clicks() * 4294967296);
    const planned = schedule.find((entry) => entry.step === step);
    const goOn = planned ? await interrupt(state, planned) : await clickStep(state, step, seed);
    if (!goOn || state.result.findings.length >= MAX_FINDINGS) break;
    await sleep(state.pauseMs);
  }
}

async function prepare(state: RunState): Promise<boolean> {
  const { config } = state;
  if (config.seedCommand) {
    const seeded = await runShell(config.seedCommand, {
      cwd: state.root,
      env: { ...process.env, ...appEnv(state) },
      timeoutMs: config.startTimeoutMs,
    });
    state.result.steps.push({
      name: "seed",
      status: seeded.ok ? "pass" : "fail",
      detail: seeded.ok ? config.seedCommand : `exit ${seeded.exitCode}`,
    });
    if (!seeded.ok) {
      report(state, {
        severity: "critical",
        area: "runner",
        title: "Desktop seed command failed",
        route: "*",
        detail: seeded.stderr.slice(-300),
        fix: "Make the seed write test records into the folder named by the data env variable.",
      });
      return false;
    }
  }
  const started = await bringBack(state, "start");
  state.result.steps.push({
    name: "start",
    status: started ? "pass" : "fail",
    detail: started ? config.startCommand : "no ready answer, or the error monitor did not install",
  });
  if (!started) {
    scanLog(state, "start");
    report(state, {
      severity: "critical",
      area: "runner",
      title: "Desktop app did not start",
      route: "start",
      detail: `see ${join(state.tmp, "app.log")}`,
      fix: `Check startCommand, the eval hook, and ${config.hookDirEnv} in the debug build.`,
    });
  }
  return started;
}

function appEnv(state: RunState): Record<string, string> {
  const hookDir = join(state.tmp, "hook");
  return {
    [state.config.dataDirEnv]: state.dataDir,
    [state.config.hookDirEnv]: hookDir,
    KIT_MONKEY_DATA_DIR: state.dataDir,
    KIT_MONKEY_HOOK_DIR: hookDir,
    RUST_BACKTRACE: "1",
  };
}

async function finish(state: RunState): Promise<void> {
  const check = await state.app.eval(PAGE_CHECK, state.config.stepTimeoutMs);
  if (check.ok) recordCheck(state, JSON.parse(String(check.value)) as PageCheck, "end of run");
  await state.app.stop("SIGTERM", 10_000);
  scanLog(state, "end of run");
  checkData(state, "end of run");
}

function checkRealData(state: RunState): void {
  const after = fingerprintDirs(state.config.realDataDirs, state.config.realDataIgnore);
  for (const dir of state.config.realDataDirs) {
    if (after[dir] === state.realBefore[dir]) continue;
    report(state, {
      severity: "critical",
      area: "security",
      title: "Real data folder changed during the run",
      route: "*",
      detail: dir,
      fix: `Make the debug build read every path from ${state.config.dataDirEnv}; the test must never touch real user data.`,
    });
  }
  state.result.steps.push({
    name: "real data",
    status: state.result.findings.some((f) => f.title === "Real data folder changed during the run")
      ? "fail"
      : "pass",
    detail: state.config.realDataDirs.join(", "),
  });
}

function loadConfig(root: string, configPath: string): DesktopConfig {
  const path = resolve(root, configPath);
  if (!existsSync(path)) throw new Error(`${configPath} not found`);
  return validateDesktopConfig(JSON.parse(readFileSync(path, "utf8")));
}

function configFailure(seed: number, message: string, configPath: string): DesktopRunResult {
  return {
    ok: false,
    seed,
    findings: [
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "Desktop monkey config missing or invalid",
        role: "desktop",
        repro: message,
        file: configPath,
        fix: "Write the config described in docs/MONKEY_TEST.md (Desktop apps): start command, data and hook env variables, real data folders, data files, records script, and the long operations to interrupt.",
      }),
    ],
    steps: [{ name: "config", status: "fail", detail: message }],
    interruptions: [],
    actions: [],
  };
}

function createState(root: string, config: DesktopConfig, options: DesktopRunOptions): RunState {
  const seed = (options.seed ?? Date.now() % 100_000) >>> 0;
  const tmp = mkdtempSync(join(tmpdir(), "kit-monkey-desktop-run-"));
  const dataDir = join(tmp, "data");
  mkdirSync(dataDir);
  mkdirSync(join(tmp, "hook"));
  const actions = options.actions ?? DESKTOP_ACTIONS;
  const state: RunState = {
    root,
    config,
    seed,
    steps: options.steps ?? 200,
    interruptionCount: options.interruptions ?? 5,
    actions,
    actionsFlag: options.actions ? ` --actions ${actions.join(",")}` : "",
    delayMs: options.delayMs ?? [100, 2_000],
    pauseMs: options.pauseMs ?? 150,
    result: { ok: false, seed, findings: [], steps: [], interruptions: [], actions: [] },
    seen: new Set(),
    tmp,
    dataDir,
    app: undefined as unknown as DesktopApp,
    realBefore: fingerprintDirs(config.realDataDirs, config.realDataIgnore),
    hidden: false,
    restarted: false,
  };
  state.app = new DesktopApp({
    command: config.startCommand,
    cwd: root,
    env: { ...process.env, ...appEnv(state) },
    hookDir: join(tmp, "hook"),
    logPath: join(tmp, "app.log"),
  });
  return state;
}

/**
 * Drives the real desktop app: seeded random clicks, and at seeded steps a long operation
 * interrupted by a lifecycle action, followed by a restart and data checks. The app runs
 * on a temporary data folder; the real data folders must be unchanged afterwards.
 */
export async function runDesktopMonkey(
  cwd: string,
  options: DesktopRunOptions = {},
): Promise<DesktopRunResult> {
  const root = resolve(cwd);
  const configPath = options.configPath ?? DESKTOP_CONFIG_PATH;
  let config: DesktopConfig;
  try {
    config = loadConfig(root, configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return configFailure((options.seed ?? 0) >>> 0, message, configPath);
  }
  const state = createState(root, config, options);
  try {
    if (await prepare(state)) await clickPass(state);
    await finish(state);
  } catch (error) {
    report(state, {
      severity: "critical",
      area: "runner",
      title: "Desktop monkey run aborted",
      route: "*",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Read the app log in the kept data folder and fix the cause.",
    });
  } finally {
    await state.app.stop("SIGKILL", 2_000);
  }
  checkRealData(state);
  if (state.hidden) {
    state.result.steps.push({
      name: "window",
      status: "pass",
      detail: "the window was hidden during part of the run (locked screen or covered window)",
    });
  }
  state.result.ok = state.result.findings.length === 0;
  if (state.result.ok) rmSync(state.tmp, { recursive: true, force: true });
  else state.result.keptDataDir = state.tmp;
  return state.result;
}
