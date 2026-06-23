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
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute a command with project environment variables loaded.
 * Loads .env.local and merges with optional env overrides.
 * The subprocess inherits parent process env + .env.local + overrides.
 */
export async function executeCommand(opts: RunOptions): Promise<RunResult> {
  const { commandArgs, cwd = process.cwd(), envOverrides = {}, inheritEnv = true } = opts;

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

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        process.stdout.write(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        process.stderr.write(chunk);
      });
    }

    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });

    child.on("error", (err) => {
      // Command not found or spawn error
      console.error(`Failed to execute command: ${err.message}`);
      resolve({
        exitCode: 127,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}
