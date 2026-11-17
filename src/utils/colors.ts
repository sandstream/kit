/**
 * Shared ANSI color codes. Single source of truth — cli.ts and output.ts
 * previously each declared an identical private copy; extracted command
 * modules import this one.
 */
/**
 * Whether kit prints ANSI colour. Read once per process: a CLI's environment does not change
 * while it runs.
 * - `NO_COLOR` set to a non-empty value: off (https://no-color.org).
 * - `FORCE_COLOR` set: on, unless it is `0` or `false` (the convention Node and npm use).
 * - Otherwise: on only when stdout is a terminal, so a pipe, a file or a CI log gets plain text.
 */
export function colorEnabled(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = process.stdout?.isTTY === true,
): boolean {
  if (env.NO_COLOR) return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force.toLowerCase() !== "false";
  return stdoutIsTTY;
}

const on = colorEnabled();
const code = (seq: string): string => (on ? seq : "");

export const c = {
  reset: code("\x1b[0m"),
  bold: code("\x1b[1m"),
  dim: code("\x1b[2m"),
  green: code("\x1b[32m"),
  red: code("\x1b[31m"),
  yellow: code("\x1b[33m"),
  cyan: code("\x1b[36m"),
  gray: code("\x1b[90m"),
} as const;
