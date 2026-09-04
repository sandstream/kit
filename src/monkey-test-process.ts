import { spawn, type ChildProcess } from "node:child_process";
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

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited or cannot be signalled.
    }
  }
}

function processTreeRunning(child: ChildProcess): boolean {
  if (!child.pid) return false;
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processTreeRunning(child) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !processTreeRunning(child);
}

export async function stopProcess(child: ChildProcess): Promise<boolean> {
  signalProcess(child, "SIGTERM");
  if (await waitForProcessTreeExit(child, 1_000)) return true;
  signalProcess(child, "SIGKILL");
  return await waitForProcessTreeExit(child, 1_000);
}

export async function runShell(
  command: string,
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    stream?: boolean;
    rawStdout?: boolean;
  },
): Promise<ShellResult> {
  return new Promise((resolveRun) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const knownSecrets = secretValuesFromEnv(opts.env);
    const stdoutWriter = createRedactingLineWriter((text) => {
      if (opts.stream) process.stdout.write(text);
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
      resolveRun(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => signalProcess(child, "SIGKILL"), 1_000);
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
