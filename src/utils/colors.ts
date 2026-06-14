/**
 * Shared ANSI color codes. Single source of truth — cli.ts and output.ts
 * previously each declared an identical private copy; extracted command
 * modules import this one.
 */
export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;
