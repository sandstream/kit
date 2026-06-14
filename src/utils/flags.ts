/**
 * Tiny argv flag helpers — one consistent way to read CLI flags instead of
 * ad-hoc `argv.indexOf("--x")` / `argv.includes("--x")` scattered per command.
 *
 * Behavior matches the historical idioms (space-separated `--flag value`,
 * boolean presence) and additionally accepts the `--flag=value` form.
 */

/** True if any of the given flag names is present in argv. */
export function hasFlag(argv: readonly string[], ...names: string[]): boolean {
  return names.some((n) => argv.includes(n));
}

/**
 * Value for `--name value` or `--name=value`. Returns `undefined` when the flag
 * is absent (or present as the final token with no following value).
 */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

/**
 * Integer value for a flag, or `fallback` when absent / non-numeric.
 * Mirrors the common `const n = idx >= 0 ? parseInt(args[idx+1]) : default` idiom.
 */
export function flagInt(argv: readonly string[], name: string, fallback: number): number {
  const raw = flagValue(argv, name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}
