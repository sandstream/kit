import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseEnvFile } from "./env-inspect.js";
import {
  createRedactingLineWriter,
  redactSecrets,
  secretValuesFromEnv,
} from "./utils/redactSecrets.js";

export interface RunOptions {
  /** Command and arguments to execute */
  commandArgs: string[];
  /** Project directory (defaults to cwd) */
  cwd?: string;
  /** Environment variable overrides (e.g., from .kit.toml) */
  envOverrides?: Record<string, string>;
  /** Inherit parent process environment */
  inheritEnv?: boolean;
  /** Stream redacted child output to this process (default true). Disable for protocol servers. */
  streamOutput?: boolean;
  /** Child standard input (default inherit). Protocol servers must use ignore. */
  stdin?: "inherit" | "ignore";
  /** Stop the process tree after this many ms, plus at most 1000ms for cleanup. 0 disables. */
  timeoutMs?: number;
  /** Cap captured stdout+stderr; kill once exceeded (default 10 MiB). 0 disables. */
  maxOutputBytes?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the subprocess was killed for exceeding timeoutMs. */
  timedOut?: boolean;
  /** True when output was capped at maxOutputBytes and the process killed. */
  truncated?: boolean;
}

export async function requireWorkingDirectory(cwd?: string): Promise<string> {
  const workDir = cwd ?? process.cwd();
  let directory;
  try {
    directory = await stat(workDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`working directory ${workDir} does not exist`, { cause: error });
    throw error;
  }
  if (!directory.isDirectory()) throw new Error(`working directory ${workDir} is not a directory`);
  return workDir;
}

/** Default wall-clock limit for a subprocess (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Default cap on combined captured output (10 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 1000;
type RunSignal = "SIGINT" | "SIGTERM";
type StopRun = (signal: RunSignal) => Promise<void>;
const activeRuns = new Set<StopRun>();
let parentSignal: RunSignal | undefined;
const onInterrupt = (): void => stopActiveRuns("SIGINT");
const onTerminate = (): void => stopActiveRuns("SIGTERM");

function removeSignalHandlers(): void {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
}

function stopActiveRuns(signal: RunSignal): void {
  if (parentSignal) return;
  parentSignal = signal;
  const restoreDefaultExit = process.listenerCount(signal) === 1;
  // One listener coordinates concurrent runs. No command can exit the parent
  // while another command still owns a process tree that needs cleanup.
  void Promise.all([...activeRuns].map((stop) => stop(signal))).then(() => {
    removeSignalHandlers();
    parentSignal = undefined;
    if (restoreDefaultExit) process.kill(process.pid, signal);
  });
}

function registerRun(stop: StopRun): () => void {
  activeRuns.add(stop);
  if (activeRuns.size === 1) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }
  return () => {
    activeRuns.delete(stop);
    if (activeRuns.size === 0 && !parentSignal) removeSignalHandlers();
  };
}

/** POSIX descendants must stay in the process group. Windows needs a live parent. */
async function terminateProcessTree(
  child: ChildProcess,
  signal?: RunSignal,
): Promise<string | undefined> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) {
      return "descendant cleanup unavailable after the parent exited";
    }
    return new Promise((resolveKill) => {
      execFile(
        resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { timeout: CLEANUP_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true },
        (error) => {
          if (error) {
            child.kill("SIGKILL");
            resolveKill("process-tree termination could not be confirmed; descendants may remain");
          } else resolveKill(undefined);
        },
      );
    });
  }
  try {
    if (signal) {
      process.kill(-child.pid, signal);
      await new Promise<void>((resolveGrace) => setTimeout(resolveGrace, 250));
    }
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      child.kill("SIGKILL");
      return "process-group termination failed; descendants may remain";
    }
  }
}

async function loadCommandEnvironment(
  cwd: string,
  inheritEnv: boolean,
  overrides: Record<string, string>,
): Promise<{ env: Record<string, string>; knownSecrets: string[] }> {
  const env: Record<string, string> = inheritEnv
    ? { ...(process.env as Record<string, string>) }
    : {};
  try {
    const content = await readFile(resolve(cwd, ".env.local"), "utf-8");
    Object.assign(env, parseEnvFile(content));
  } catch {
    // .env.local is optional.
  }
  Object.assign(env, overrides);
  const knownSecrets = secretValuesFromEnv(env);
  return { env, knownSecrets };
}

export async function redactCommandForEnvironment(
  command: string,
  cwd: string = process.cwd(),
): Promise<string> {
  const { knownSecrets } = await loadCommandEnvironment(cwd, true, {});
  return redactSecrets(command, knownSecrets);
}

/** Redact raw arguments before a caller adds display quotes or JSON escapes. */
export async function redactArgumentsForEnvironment(
  commandArgs: readonly string[],
  cwd = process.cwd(),
  options: Pick<RunOptions, "envOverrides" | "inheritEnv"> = {},
): Promise<string[]> {
  const { knownSecrets } = await loadCommandEnvironment(
    cwd,
    options.inheritEnv ?? true,
    options.envOverrides ?? {},
  );
  return commandArgs.map((arg) => redactSecrets(arg, knownSecrets));
}

type ProcessOptions = Required<
  Pick<
    RunOptions,
    "commandArgs" | "cwd" | "streamOutput" | "stdin" | "timeoutMs" | "maxOutputBytes"
  >
>;
type OutputStream = "stdout" | "stderr";

/** Decode, cap, redact, and forward both child output streams. */
class CommandOutput {
  private readonly text = { stdout: "", stderr: "" };
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  private readonly writers: Record<OutputStream, ReturnType<typeof createRedactingLineWriter>>;
  private captured = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly stream: boolean,
    private readonly knownSecrets: string[],
  ) {
    this.writers = {
      stdout: createRedactingLineWriter((text) => {
        if (stream) process.stdout.write(text);
      }, knownSecrets),
      stderr: createRedactingLineWriter((text) => {
        if (stream) process.stderr.write(text);
      }, knownSecrets),
    };
  }

  private appendText(target: OutputStream, text: string): void {
    this.text[target] += text;
    this.writers[target].append(text);
  }

  /** Return true only when the chunk exceeds the shared byte cap. */
  append(target: OutputStream, chunk: Buffer): boolean {
    const remaining = this.maxBytes > 0 ? this.maxBytes - this.captured : Infinity;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.appendText(target, this.decoders[target].write(slice));
    this.captured += slice.length;
    return this.maxBytes > 0 && chunk.length > remaining;
  }

  private flush(): void {
    this.writers.stdout.flush();
    this.writers.stderr.flush();
  }

  finish(discardIncomplete: boolean, diagnostics: string[]): Pick<RunResult, "stdout" | "stderr"> {
    // Limits can cut a valid character mid-sequence. Ordinary EOF still replaces invalid bytes.
    if (!discardIncomplete) {
      this.appendText("stdout", this.decoders.stdout.end());
      this.appendText("stderr", this.decoders.stderr.end());
    }
    for (const detail of diagnostics) this.appendText("stderr", `\n[kit] ${detail}`);
    this.flush();
    return {
      stdout: redactSecrets(this.text.stdout, this.knownSecrets),
      stderr: redactSecrets(this.text.stderr, this.knownSecrets),
    };
  }

  spawnError(error: Error): RunResult {
    this.flush();
    const message = redactSecrets(error.message, this.knownSecrets);
    if (this.stream) console.error(`Failed to execute command: ${message}`);
    return { exitCode: 127, stdout: "", stderr: message };
  }
}

/** Own one child's limits, signal registration, completion, and bounded cleanup. */
class CommandProcess {
  private readonly child: ChildProcess;
  private readonly output: CommandOutput;
  private readonly timer: NodeJS.Timeout | null;
  private readonly unregister: () => void;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private timedOut = false;
  private truncated = false;
  private settled = false;
  private stopping = false;
  private killPending = false;
  private closed = false;
  private closeExitCode: number | null = null;
  private cleanupIssue: string | undefined;
  private interrupted: RunSignal | undefined;
  private notifyStopped!: () => void;
  private resolveResult!: (result: RunResult) => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.notifyStopped = resolve;
  });
  readonly result = new Promise<RunResult>((resolve) => {
    this.resolveResult = resolve;
  });

  constructor(
    private readonly opts: ProcessOptions,
    env: Record<string, string>,
    knownSecrets: string[],
  ) {
    const [command, ...args] = opts.commandArgs;
    this.child = spawn(command, args, {
      cwd: opts.cwd,
      env,
      stdio: [opts.stdin, "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.output = new CommandOutput(opts.maxOutputBytes, opts.streamOutput, knownSecrets);
    // Keep the timer active after the leader exits until its pipes close.
    this.timer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            this.timedOut = true;
            this.stop();
          }, opts.timeoutMs)
        : null;
    this.timer?.unref();
    this.unregister = registerRun((signal) => this.interrupt(signal));
    this.child.stdout?.on("data", (chunk: Buffer) => this.capture("stdout", chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => this.capture("stderr", chunk));
    this.child.on("close", (code) => this.onClose(code));
    this.child.on("error", (error) => this.onError(error));
  }

  private interrupt(signal: RunSignal): Promise<void> {
    this.interrupted = signal;
    this.stop();
    return this.stopped;
  }

  private stop(): void {
    if (this.stopping || this.settled) return;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.cleanupTimer = setTimeout(() => this.forceCleanup(), CLEANUP_TIMEOUT_MS);
    this.killPending = true;
    void terminateProcessTree(this.child, this.interrupted)
      .catch(() => {
        this.child.kill("SIGKILL");
        return "process-tree termination failed; descendants may remain";
      })
      .then((issue) => {
        this.cleanupIssue ??= issue;
        this.killPending = false;
        if (this.closed) this.complete(this.closeExitCode);
      });
  }

  private forceCleanup(): void {
    // Escaped descendants can retain pipes. They must not make this wait unbounded.
    this.cleanupIssue ??= "cleanup deadline reached; output pipes closed; descendants may remain";
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.unref();
    this.complete(this.closeExitCode);
  }

  private capture(target: OutputStream, chunk: Buffer): void {
    if (this.stopping || this.settled) return;
    if (this.output.append(target, chunk)) {
      this.truncated = true;
      this.stop();
    }
  }

  private finish(result: RunResult): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    clearTimeout(this.cleanupTimer);
    this.unregister();
    this.notifyStopped();
    this.resolveResult(result);
  }

  private diagnostics(): string[] {
    const details: string[] = [];
    if (this.interrupted) {
      details.push(`command interrupted by ${this.interrupted}; termination requested`);
    } else if (this.timedOut) {
      details.push(`command timed out after ${this.opts.timeoutMs}ms; termination requested`);
    } else if (this.truncated) {
      details.push(
        `output exceeded ${this.opts.maxOutputBytes} bytes; termination requested, output truncated`,
      );
    }
    if (this.cleanupIssue) details.push(this.cleanupIssue);
    return details;
  }

  private exitCode(code: number | null): number {
    if (this.interrupted) return this.interrupted === "SIGINT" ? 130 : 143;
    // A normal exit can race with a limit. Exceeding a limit still means failure.
    return this.timedOut || this.truncated ? 124 : (code ?? 1);
  }

  private complete(code: number | null): void {
    if (this.settled) return;
    const discardIncomplete = this.timedOut || this.truncated || this.interrupted !== undefined;
    this.finish({
      exitCode: this.exitCode(code),
      ...this.output.finish(discardIncomplete, this.diagnostics()),
      ...(this.timedOut && { timedOut: true }),
      ...(this.truncated && { truncated: true }),
    });
  }

  private onClose(code: number | null): void {
    this.closed = true;
    this.closeExitCode = code;
    if (!this.killPending) this.complete(code);
  }

  private onError(error: Error): void {
    if (this.stopping) {
      this.cleanupIssue = "process termination failed; descendants may remain";
      return;
    }
    this.finish(this.output.spawnError(error));
  }
}

/** Execute a command with parent environment, optional .env.local, and explicit overrides. */
export async function executeCommand(opts: RunOptions): Promise<RunResult> {
  const {
    commandArgs,
    cwd = process.cwd(),
    envOverrides = {},
    inheritEnv = true,
    streamOutput = true,
    stdin = "inherit",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = opts;
  if (commandArgs.length === 0) throw new Error("No command provided");
  const { env, knownSecrets } = await loadCommandEnvironment(cwd, inheritEnv, envOverrides);
  if (parentSignal) throw new Error(`Cannot start a command during ${parentSignal} cleanup`);
  return new CommandProcess(
    { commandArgs, cwd, streamOutput, stdin, timeoutMs, maxOutputBytes },
    env,
    knownSecrets,
  ).result;
}
