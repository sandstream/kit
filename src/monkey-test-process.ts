import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { MonkeyProcessScope } from "./monkey-test-runner-processes.js";
import {
  createRedactingLineWriter,
  redactSecrets,
  secretValuesFromEnv,
} from "./utils/redactSecrets.js";

export interface ShellResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function signalProcess(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // A shell command runs below cmd.exe. Killing only that shell leaves its
    // child holding stdout/stderr open, so `close` never fires after timeout.
    await new Promise<void>((resolveKill) => {
      execFile(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { timeout: 5_000, windowsHide: true },
        (error) => {
          if (error) {
            try {
              child.kill(signal);
            } catch {
              /* already exited */
            }
          }
          resolveKill();
        },
      );
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited or cannot be signalled.
    }
  }
}

export function processTreeRunning(child: ChildProcess): boolean {
  if (!child.pid) return false;
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processTreeRunning(child)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !processTreeRunning(child);
}

export async function stopProcess(child: ChildProcess): Promise<boolean> {
  if (!processTreeRunning(child)) return true;
  await signalProcess(child, "SIGTERM");
  if (await waitForProcessTreeExit(child, 1_000)) return true;
  await signalProcess(child, "SIGKILL");
  return await waitForProcessTreeExit(child, 1_000);
}

function finishShell(
  child: ChildProcess,
  processes: MonkeyProcessScope | undefined,
  result: ShellResult,
  resolveRun: (result: ShellResult) => void,
): void {
  if (!processes) return resolveRun(result);
  void processes.stopChild(child).then((stopped) => {
    resolveRun({ ...result, ok: result.ok && stopped });
  });
}

export async function runShell(
  command: string,
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    stream?: boolean;
    rawStdout?: boolean;
    processes?: MonkeyProcessScope;
  },
): Promise<ShellResult> {
  return new Promise((resolveRun) => {
    opts.processes?.signal.throwIfAborted();
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    opts.processes?.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const knownSecrets = secretValuesFromEnv(opts.env);
    const stdoutWriter = createRedactingLineWriter((text) => {
      if (opts.stream) process.stderr.write(text);
    }, knownSecrets);
    const stderrWriter = createRedactingLineWriter((text) => {
      if (opts.stream) process.stderr.write(text);
    }, knownSecrets);
    const finish = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      stdoutWriter.flush();
      stderrWriter.flush();
      finishShell(child, opts.processes, result, resolveRun);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void signalProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        void signalProcess(child, "SIGKILL");
      }, 1_000);
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      stdoutWriter.append(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      stderrWriter.append(text);
    });
    child.on("close", (code) => {
      finish({
        ok: code === 0 && !timedOut,
        exitCode: code ?? 1,
        stdout: opts.rawStdout ? stdout : redactSecrets(stdout, knownSecrets),
        stderr: redactSecrets(stderr, knownSecrets),
        timedOut,
      });
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        exitCode: 127,
        stdout: opts.rawStdout ? stdout : redactSecrets(stdout, knownSecrets),
        stderr: redactSecrets(error.message, knownSecrets),
        timedOut,
      });
    });
  });
}
