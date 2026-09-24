import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
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
  /** Kill the subprocess after this many ms (default 120000). 0 disables. */
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
  if (!directory.isDirectory())
    throw new Error(`working directory ${workDir} is not a directory`);
  return workDir;
}

/** Default wall-clock limit for a subprocess (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Default cap on combined captured output (10 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
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

/**
 * Execute a command with project environment variables loaded.
 * Loads .env.local and merges with optional env overrides.
 * The subprocess inherits parent process env + .env.local + overrides.
 */
export async function executeCommand(opts: RunOptions): Promise<RunResult> {
  const {
    commandArgs,
    cwd = process.cwd(),
    envOverrides = {},
    inheritEnv = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = opts;

  if (commandArgs.length === 0) {
    throw new Error("No command provided");
  }

  const { env, knownSecrets } = await loadCommandEnvironment(cwd, inheritEnv, envOverrides);

  // Execute the command
  return new Promise((resolve) => {
    const [command, ...args] = commandArgs;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let captured = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const stdoutWriter = createRedactingLineWriter(
      (text) => process.stdout.write(text),
      knownSecrets,
    );
    const stderrWriter = createRedactingLineWriter(
      (text) => process.stderr.write(text),
      knownSecrets,
    );

    // Wall-clock timeout — kill a runaway/hung subprocess.
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;
    timer?.unref();

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (truncated) return;
      const remaining = maxOutputBytes > 0 ? maxOutputBytes - captured : Infinity;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      const text = slice.toString();
      if (target === "stdout") {
        stdout += text;
        stdoutWriter.append(text);
      } else {
        stderr += text;
        stderrWriter.append(text);
      }
      captured += slice.length;
      if (maxOutputBytes > 0 && captured >= maxOutputBytes) {
        truncated = true;
        child.kill("SIGKILL");
      }
    };

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    }

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.on("close", (exitCode) => {
      if (timedOut) {
        const detail = `\n[kit] command timed out after ${timeoutMs}ms — killed`;
        stderr += detail;
        stderrWriter.append(detail);
      } else if (truncated) {
        const detail = `\n[kit] output exceeded ${maxOutputBytes} bytes — killed, output truncated`;
        stderr += detail;
        stderrWriter.append(detail);
      }
      stdoutWriter.flush();
      stderrWriter.flush();
      finish({
        // A killed process reports null exitCode; surface as non-zero failure.
        exitCode: exitCode ?? (timedOut || truncated ? 124 : 1),
        stdout: redactSecrets(stdout, knownSecrets),
        stderr: redactSecrets(stderr, knownSecrets),
        ...(timedOut && { timedOut }),
        ...(truncated && { truncated }),
      });
    });

    child.on("error", (err) => {
      // Command not found or spawn error
      stdoutWriter.flush();
      stderrWriter.flush();
      const message = redactSecrets(err.message, knownSecrets);
      console.error(`Failed to execute command: ${message}`);
      finish({
        exitCode: 127,
        stdout: "",
        stderr: message,
      });
    });
  });
}
