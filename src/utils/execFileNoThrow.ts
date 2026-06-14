import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
}

/**
 * Runs a command safely using execFile (no shell, no injection risk).
 * Never throws — returns structured result with exitCode and ok flag.
 */
export async function execFileNoThrow(
  command: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options?.timeout ?? 30_000,
      env: options?.env ?? process.env,
    });
    return { stdout, stderr, exitCode: 0, ok: true };
  } catch (error: unknown) {
    if (error && typeof error === "object") {
      const e = error as { stdout?: string; stderr?: string; code?: number | string };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: typeof e.code === "number" ? e.code : 1,
        ok: false,
      };
    }
    return { stdout: "", stderr: String(error), exitCode: 1, ok: false };
  }
}
