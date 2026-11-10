/**
 * Shared ANSI color codes. Single source of truth — cli.ts and output.ts
 * previously each declared an identical private copy; extracted command
 * modules import this one.
 */
/**
 * True unless `NO_COLOR` is set to a non-empty value (https://no-color.org). Read once per
 * process: a CLI's environment does not change while it runs.
 */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.NO_COLOR;
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
