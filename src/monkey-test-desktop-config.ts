import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const DESKTOP_CONFIG_PATH = ".kit/monkey-test/desktop.json";

/**
 * Lifecycle actions a real user takes while the app works. Each one runs while a long
 * operation is in progress:
 *
 * - `close-window`: the window's close button (the app's own close path).
 * - `quit`: SIGTERM to the app's process group, then a pause before the next start.
 * - `kill`: SIGKILL, as a crash or a forced quit does. No cleanup code runs.
 * - `reload`: reload the page. The process keeps running.
 * - `restart`: SIGTERM and start again at once, without the pause.
 */
export const DESKTOP_ACTIONS = ["close-window", "quit", "kill", "reload", "restart"] as const;
export type DesktopAction = (typeof DESKTOP_ACTIONS)[number];

/** A long operation the user can start and then interrupt. */
export interface DesktopOperation {
  name: string;
  /** Function body run in the app's main window. Starts the operation. */
  start: string;
  /**
   * Function body run after the app is back. Returns "done" (finished), "interrupted"
   * (the UI says it stopped), or "running" (still working; the driver waits). Any other
   * answer means the work disappeared without a message, which is a finding.
   */
  outcome: string;
}

export interface DesktopConfig {
  /** Starts the debug build, for example `bun run tauri dev`. */
  startCommand: string;
  /** Optional seed. Runs before the first start with the temporary data folder set. */
  seedCommand?: string;
  /** Env variable the debug build reads its data folder from. */
  dataDirEnv: string;
  /** Env variable the debug build reads its eval-hook folder from. */
  hookDirEnv: string;
  /** The app's real data folders. They must be unchanged after the run. */
  realDataDirs: string[];
  /** Paths under the real data folders the check ignores, such as downloaded models. */
  realDataIgnore: string[];
  /** Globs under the data folder for every file the app owns. Each must parse. */
  dataFiles: string[];
  /** Function body that returns a truthy value when the UI is ready. */
  ready: string;
  /** Function body that returns the records the UI shows, as an array of strings. */
  records: string;
  operations: DesktopOperation[];
  /** Function body that closes the main window the way the user does. */
  closeWindow: string;
  /** Extra regular expressions that mark a crash in the app log. */
  logCrashPatterns: string[];
  startTimeoutMs: number;
  stepTimeoutMs: number;
  operationTimeoutMs: number;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`desktop config: ${name} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requireText(value, name);
}

function requireTextList(value: unknown, name: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`desktop config: ${name} must be a non-empty array of strings`);
  }
  return value.map((entry, index) => requireText(entry, `${name}[${index}]`));
}

function requireEnvName(value: unknown, name: string): string {
  const text = requireText(value, name);
  if (!ENV_NAME.test(text)) {
    throw new Error(`desktop config: ${name} must be an env variable name such as APP_DATA_DIR`);
  }
  return text;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function positiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`desktop config: ${name} must be a positive integer`);
  }
  return value as number;
}

function operations(value: unknown): DesktopOperation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      "desktop config: operations must list at least one long operation to interrupt",
    );
  }
  return value.map((entry, index) => {
    const operation = (entry ?? {}) as Record<string, unknown>;
    return {
      name: requireText(operation.name, `operations[${index}].name`),
      start: requireText(operation.start, `operations[${index}].start`),
      outcome: requireText(operation.outcome, `operations[${index}].outcome`),
    };
  });
}

function realDataDirs(value: unknown): string[] {
  const dirs = requireTextList(value, "realDataDirs").map(expandHome);
  const relative = dirs.find((dir) => !isAbsolute(dir));
  if (relative) {
    throw new Error(
      `desktop config: realDataDirs must be absolute paths or start with ~/ (${relative})`,
    );
  }
  return dirs;
}

export function validateDesktopConfig(value: unknown): DesktopConfig {
  if (!value || typeof value !== "object") throw new Error("desktop config must be a JSON object");
  const raw = value as Record<string, unknown>;
  const startCommand = requireText(raw.startCommand, "startCommand");
  const dataDirEnv = requireEnvName(raw.dataDirEnv, "dataDirEnv");
  const hookDirEnv = requireEnvName(raw.hookDirEnv, "hookDirEnv");
  if (dataDirEnv === hookDirEnv) {
    throw new Error("desktop config: dataDirEnv and hookDirEnv must differ");
  }
  return {
    startCommand,
    seedCommand: optionalText(raw.seedCommand, "seedCommand"),
    dataDirEnv,
    hookDirEnv,
    realDataDirs: realDataDirs(raw.realDataDirs),
    realDataIgnore:
      raw.realDataIgnore === undefined
        ? []
        : requireTextList(raw.realDataIgnore, "realDataIgnore", true),
    dataFiles: requireTextList(raw.dataFiles, "dataFiles"),
    ready: optionalText(raw.ready, "ready") ?? "return document.body.innerText.trim().length > 0;",
    records: requireText(raw.records, "records"),
    operations: operations(raw.operations),
    closeWindow: optionalText(raw.closeWindow, "closeWindow") ?? "window.close(); return 'ok';",
    logCrashPatterns:
      raw.logCrashPatterns === undefined
        ? []
        : requireTextList(raw.logCrashPatterns, "logCrashPatterns", true),
    startTimeoutMs: positiveInt(raw.startTimeoutMs, "startTimeoutMs", 300_000),
    stepTimeoutMs: positiveInt(raw.stepTimeoutMs, "stepTimeoutMs", 60_000),
    operationTimeoutMs: positiveInt(raw.operationTimeoutMs, "operationTimeoutMs", 120_000),
  };
}
