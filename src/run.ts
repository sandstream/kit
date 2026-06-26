import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

/** Default wall-clock limit for a subprocess (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Default cap on combined captured output (10 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

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

  // Build environment
  const env: Record<string, string> = inheritEnv
    ? { ...(process.env as Record<string, string>) }
    : {};

  // Load .env.local if it exists
  const envPath = resolve(cwd, ".env.local");
  try {
    const envContent = await readFile(envPath, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.substring(0, eqIndex);
      const value = trimmed.substring(eqIndex + 1);
      env[key] = value;
    }
  } catch {
    // .env.local not found or unreadable — continue with existing env
  }

  // Apply overrides
  for (const [key, value] of Object.entries(envOverrides)) {
    env[key] = value;
  }

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
        process.stdout.write(slice);
      } else {
        stderr += text;
        process.stderr.write(slice);
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
        stderr += `\n[kit] command timed out after ${timeoutMs}ms — killed`;
      } else if (truncated) {
        stderr += `\n[kit] output exceeded ${maxOutputBytes} bytes — killed, output truncated`;
      }
      finish({
        // A killed process reports null exitCode; surface as non-zero failure.
        exitCode: exitCode ?? (timedOut || truncated ? 124 : 1),
        stdout,
        stderr,
        ...(timedOut && { timedOut }),
        ...(truncated && { truncated }),
      });
    });

    child.on("error", (err) => {
      // Command not found or spawn error
      console.error(`Failed to execute command: ${err.message}`);
      finish({
        exitCode: 127,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}
