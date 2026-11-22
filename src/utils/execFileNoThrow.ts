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
  /** True when the timeout killed the process (stdout is then only what it had printed). */
  timedOut?: boolean;
  /** The child did not return a numeric exit status. */
  noNumericExitStatus?: true;
  /** The OS did not start the child. */
  didNotStart?: true;
}

/** 64 MiB, the limit most callers already set. A report grows with what a scanner finds. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

const MAXBUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

function failureResult(error: unknown): ExecResult {
  if (!error || typeof error !== "object") {
    return {
      stdout: "",
      stderr: String(error),
      exitCode: 1,
      ok: false,
      noNumericExitStatus: true,
      didNotStart: true,
    };
  }
  const e = error as {
    stdout?: string;
    stderr?: string;
    code?: number | string;
    killed?: boolean;
    signal?: string;
  };
  const result: ExecResult = {
    stdout: e.stdout ?? "",
    stderr: e.stderr ?? "",
    exitCode: typeof e.code === "number" ? e.code : 1,
    ok: false,
  };
  if (typeof e.code !== "number") result.noNumericExitStatus = true;
  if (e.code === MAXBUFFER_CODE) result.truncated = true;
  else if (e.killed === true && e.signal === "SIGTERM") result.timedOut = true;
  else if (typeof e.code === "string" && !e.signal) result.didNotStart = true;
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
      // Tool reporters (lizard --csv, scc --by-file, trivy, osv-scanner) can exceed Node's 1 MB
      // default on a large repo; a truncated stream would corrupt the parse. The default is
      // generous and callers may still set their own.
      maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });
    return { stdout, stderr, exitCode: 0, ok: true };
  } catch (error: unknown) {
    return failureResult(error);
  }
}

/**
 * A failure message that says when the cause was kit's own output or time limit, so a report that did not
 * fit is not mistaken for a tool that crashed.
 */
export function failedDetail(
  base: string,
  result: Pick<ExecResult, "ok" | "truncated" | "timedOut">,
): string {
  if (result.truncated) {
    return `${base}: the output exceeded kit's buffer limit and was cut off (a kit limit, not a tool failure)`;
  }
  if (result.timedOut)
    return `${base}: stopped at kit's time limit (a kit limit, not a tool failure)`;
  return base;
}
