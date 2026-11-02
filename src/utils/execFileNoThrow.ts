import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
  /** True when the output exceeded maxBuffer and was cut off (stdout is then only the start). */
  truncated?: boolean;
}

const MAXBUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

function failureResult(error: unknown): ExecResult {
  if (!error || typeof error !== "object") {
    return { stdout: "", stderr: String(error), exitCode: 1, ok: false };
  }
  const e = error as { stdout?: string; stderr?: string; code?: number | string };
  const result: ExecResult = {
    stdout: e.stdout ?? "",
    stderr: e.stderr ?? "",
    exitCode: typeof e.code === "number" ? e.code : 1,
    ok: false,
  };
  if (e.code === MAXBUFFER_CODE) result.truncated = true;
  return result;
}

/**
 * Runs a command safely using execFile (no shell, no injection risk).
 * Never throws — returns structured result with exitCode and ok flag.
 */
export async function execFileNoThrow(
  command: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number; cwd?: string },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options?.timeout ?? 30_000,
      env: options?.env ?? process.env,
      cwd: options?.cwd,
      // Tool reporters (lizard --csv, scc --by-file) can exceed Node's 1 MB default
      // on a large repo; a truncated stream would corrupt the parse. Let callers raise it.
      maxBuffer: options?.maxBuffer ?? 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0, ok: true };
  } catch (error: unknown) {
    return failureResult(error);
  }
}
