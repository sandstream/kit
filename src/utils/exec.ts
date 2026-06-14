import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

/**
 * Canonical promisified execFile for the whole codebase.
 *
 * Why a shared module: 30+ files previously declared their own
 * `const exec = promisify(execFile)` — three lines of boilerplate per
 * file, and a drift risk (anyone "simplifying" to `exec` from
 * node:child_process reintroduces shell-injection surface). Import this
 * instead:
 *
 *   import { exec } from "./utils/exec.js";
 *
 * SECURITY INVARIANT: always pass arguments as an array. Never build a
 * shell string. execFile does not spawn a shell, so metacharacters in
 * arguments are inert.
 *
 * For a never-throwing variant returning { stdout, stderr, exitCode, ok },
 * use execFileNoThrow from ./execFileNoThrow.js.
 */
export const exec = promisify(execFileCb);

export { execFileNoThrow, type ExecResult } from "./execFileNoThrow.js";
