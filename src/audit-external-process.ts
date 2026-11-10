import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 1_000;

type HostSignal = "SIGINT" | "SIGTERM";
type StopOnSignal = (signal: HostSignal) => Promise<void>;
const activeCalls = new Set<StopOnSignal>();
let hostSignal: HostSignal | undefined;
const onHostInterrupt = (): void => interruptCalls("SIGINT");
const onHostTerminate = (): void => interruptCalls("SIGTERM");

function removeHostListeners(): void {
  process.off("SIGINT", onHostInterrupt);
  process.off("SIGTERM", onHostTerminate);
}

function interruptCalls(signal: HostSignal): void {
  if (hostSignal) return;
  hostSignal = signal;
  const restoreDefaultExit = process.listenerCount(signal) === 1;
  // Stop every group before default host exit. Each stop also waits for earlier failure cleanup.
  void Promise.allSettled([...activeCalls].map((stop) => stop(signal))).then(() => {
    removeHostListeners();
    hostSignal = undefined;
    // Other listeners keep control, including once listeners that ran during this signal.
    if (restoreDefaultExit && process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal);
    }
  });
}

function registerHostCleanup(stop: StopOnSignal): () => void {
  activeCalls.add(stop);
  if (activeCalls.size === 1) {
    // Start POSIX group cleanup before a previously registered host listener can exit.
    process.prependListener("SIGINT", onHostInterrupt);
    process.prependListener("SIGTERM", onHostTerminate);
  }
  return () => {
    activeCalls.delete(stop);
    if (activeCalls.size === 0 && !hostSignal) removeHostListeners();
  };
}

function serializeInput(input: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    // Input hooks can throw secrets. Do not retain the original error as a cause.
    throw new Error("External command input is not JSON serializable");
  }
  if (json === undefined) throw new Error("External command input is not JSON serializable");
  if (Buffer.byteLength(json, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("External command input exceeds the byte limit");
  }
  return json;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMP", "TEMP"]) {
    const source =
      process.platform === "win32"
        ? Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase())
        : key;
    if (source && process.env[source] !== undefined) env[key] = process.env[source];
  }
  if (process.platform === "win32") env.SystemRoot ??= "C:\\Windows";
  return env;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statementEnvironment(input: unknown): NodeJS.ProcessEnv {
  // Only transport types belong here. The caller validates the proof schema.
  if (!record(input) || !Object.hasOwn(input, "statement")) return {};
  const statement = input.statement;
  if (
    !record(statement) ||
    typeof statement.tip !== "string" ||
    statement.tip.includes("\0") ||
    typeof statement.count !== "number" ||
    typeof statement.logPath !== "string" ||
    statement.logPath.includes("\0")
  ) {
    throw new Error("External command statement is invalid");
  }
  return {
    KIT_ANCHOR_TIP: statement.tip,
    KIT_ANCHOR_COUNT: String(statement.count),
    KIT_ANCHOR_LOGPATH: statement.logPath,
  };
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Descendants must stay in the POSIX group. Windows taskkill needs a live parent. */
async function stopTree(
  child: ChildProcessWithoutNullStreams,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) {
      return "Windows descendant cleanup cannot be verified after parent exit";
    }
    return new Promise((resolve) => {
      execFile(
        join(env.SystemRoot!, "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          cwd: homedir(),
          env,
          timeout: CLEANUP_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024,
          windowsHide: true,
        },
        (error) => {
          if (error) {
            child.kill("SIGKILL");
            resolve("Windows process tree cleanup could not be verified");
          } else resolve(undefined);
        },
      );
    });
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      child.kill("SIGKILL");
      return "Process group cleanup could not be verified";
    }
  }
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  while (groupExists(child.pid) || (child.exitCode === null && child.signalCode === null)) {
    if (Date.now() >= deadline) return "Process group cleanup could not be verified";
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

interface ProtocolOptions {
  env: NodeJS.ProcessEnv;
  json: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface ProtocolLifecycle {
  readonly settled: boolean;
  fail(message: string): void;
  succeed(output: string): void;
}

interface ProtocolCompletion {
  resolve(output: string): void;
  reject(error: Error): void;
}

/** Own settlement, host interruption, and cleanup for one command. */
function createProtocolLifecycle(
  child: ChildProcessWithoutNullStreams,
  opts: ProtocolOptions,
  completion: ProtocolCompletion,
): ProtocolLifecycle {
  let settled = false;
  let completeCleanup!: () => void;
  const cleanupComplete = new Promise<void>((resolveCleanup) => {
    completeCleanup = resolveCleanup;
  });
  const unregister = registerHostCleanup((signal) => {
    fail(`External command interrupted by host ${signal}`);
    return cleanupComplete;
  });
  const timer = setTimeout(() => fail("External command timeout"), opts.timeoutMs);

  function release(): void {
    unregister();
    completeCleanup();
  }

  function fail(message: string): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const finishFailure = (cleanupError?: string): void => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      release();
      completion.reject(new Error(cleanupError ? `${message}; ${cleanupError}` : message));
    };
    void stopTree(child, opts.env).then(finishFailure, () => {
      finishFailure("Process tree cleanup could not be verified");
    });
  }

  return {
    get settled() {
      return settled;
    },
    fail,
    succeed(output) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      completion.resolve(output);
    },
  };
}

/** Capture both streams under one byte limit and require their complete end events. */
function captureProtocolOutput(
  child: ChildProcessWithoutNullStreams,
  maxOutputBytes: number,
  lifecycle: ProtocolLifecycle,
): { complete(): boolean; read(): string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let stdoutComplete = false;
  let stderrComplete = false;

  function capture(target: Buffer[], chunk: Buffer): void {
    if (lifecycle.settled) return;
    bytes += chunk.length;
    if (bytes > maxOutputBytes) lifecycle.fail("External command output exceeds the byte limit");
    else target.push(chunk);
  }

  child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
  child.stdout.on("end", () => {
    stdoutComplete = true;
  });
  child.stderr.on("end", () => {
    stderrComplete = true;
  });
  child.stdout.on("error", () => lifecycle.fail("External command stdout failed"));
  child.stderr.on("error", () => lifecycle.fail("External command stderr failed"));
  return {
    complete: () => stdoutComplete && stderrComplete,
    read: () =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(stdout)),
  };
}

function collectOutput(
  child: ChildProcessWithoutNullStreams,
  opts: ProtocolOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lifecycle = createProtocolLifecycle(child, opts, { resolve, reject });
    const output = captureProtocolOutput(child, opts.maxOutputBytes, lifecycle);
    const { fail } = lifecycle;
    let stdinComplete = false;
    child.on("error", () => fail("External command could not start"));
    child.stdin.on("error", () => fail("External command stdin failed"));
    child.on("exit", (code, signal) => {
      if (signal) fail("External command exited on a signal");
      else if (code !== 0) fail("External command exited with a nonzero status");
      else if (child.pid && process.platform !== "win32" && groupExists(child.pid)) {
        fail("External command left lingering children");
      }
    });
    child.on("close", (code, signal) => {
      if (lifecycle.settled) return;
      if (code !== 0 || signal) return fail("External command failed");
      if (!stdinComplete) return fail("External command stdin failed");
      if (!output.complete()) return fail("External command output is incomplete");
      let text: string;
      try {
        text = output.read();
      } catch {
        return fail("External command stdout is not valid UTF-8");
      }
      lifecycle.succeed(text);
    });
    child.stdin.end(opts.json, (error?: Error | null) => {
      if (error) fail("External command stdin failed");
      else stdinComplete = true;
    });
  });
}

function protocolLimits(opts: { timeoutMs?: number; maxOutputBytes?: number }): {
  timeoutMs: number;
  maxOutputBytes: number;
} {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_INPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("External command timeout must be a positive timer interval");
  }
  if (
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > MAX_INPUT_BYTES
  ) {
    throw new Error("External command output limit must be between 1 byte and 1 MiB");
  }
  return { timeoutMs, maxOutputBytes };
}

/**
 * Execute an explicit trusted operator command. Never construct command from protocol input.
 * JSON input and combined stdout/stderr each have a 1 MiB ceiling. maxOutputBytes can lower the output ceiling.
 * The default timeout is 30 seconds, with up to one extra second for process cleanup.
 * Host SIGINT and SIGTERM stop active calls. Other host listeners remain installed and retain control of host exit.
 * Without other listeners, the host exits on the original signal after cleanup. SIGKILL cannot trigger cleanup.
 * POSIX descendants must remain in the process group. Children that call setsid or setpgid can escape cleanup.
 * Windows taskkill needs a live parent. After parent exit, descendants without open pipes cannot be detected here.
 * This transport does not validate proofs or provide an operating system sandbox.
 */
export async function runExternalProtocol(
  command: string,
  input: unknown,
  opts: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string> {
  if (hostSignal) throw new Error(`External command interrupted by host ${hostSignal}`);
  const { timeoutMs, maxOutputBytes } = protocolLimits(opts);
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) {
    throw new Error("External command is invalid");
  }
  const json = serializeInput(input);
  const env = { ...minimalEnvironment(), ...statementEnvironment(JSON.parse(json)) };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, {
      shell:
        process.platform === "win32" ? join(env.SystemRoot!, "System32", "cmd.exe") : "/bin/sh",
      cwd: homedir(),
      env,
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch {
    throw new Error("External command could not start");
  }
  return collectOutput(child, { env, json, timeoutMs, maxOutputBytes });
}
