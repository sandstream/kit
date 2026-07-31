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

/** True for the usual truthy env-flag spellings (1/true/yes/on); false otherwise. */
export function envTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Flags present in argv that are not in `allowed`.
 *
 * kit's commands historically read only the flags they know and ignored the rest,
 * which makes a typo — or a flag that never existed — indistinguishable from a
 * working one. `kit check --category security` ran the FULL check for as long as it
 * was documented, in kit's own CLAUDE.md and in a CI workflow, because nothing
 * rejected it. A flag that silently does nothing is the same class of defect as a
 * check that silently does not run.
 *
 * `--` and everything after it is left alone (pass-through args). `--flag=value` is
 * compared on the flag part. Bare `-x` short flags are not inspected.
 */
export function unknownFlags(argv: readonly string[], allowed: readonly string[]): string[] {
  const stop = argv.indexOf("--");
  const scanned = stop < 0 ? argv : argv.slice(0, stop);
  const allow = new Set(allowed);
  const bad: string[] = [];
  for (const token of scanned) {
    if (!token.startsWith("--") || token === "--") continue;
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (!allow.has(name) && !bad.includes(name)) bad.push(name);
  }
  return bad;
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
