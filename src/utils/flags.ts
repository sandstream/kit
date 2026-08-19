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

/**
 * Flags kit honors for EVERY command, wherever they appear in argv.
 *
 * A command's own allowlist must accept these on top of its own flags, or the
 * unknown-flag rejection turns a documented global into a hard failure. That is
 * not hypothetical: `kit check --read-only` and `kit check --non-interactive`
 * — both listed in the "Global flags" table of docs/COMMANDS.md — exited 1 with
 * "unknown flag for kit check" and the check never ran, because CHECK_FLAGS was
 * built from the check path's own flag literals only.
 *
 * `--env` is honored globally too (config.ts:resolveActiveEnvironment reads
 * `--env=<name>` straight off process.argv) even though the COMMANDS.md table
 * predates it. `--help` is intercepted in cli.ts before dispatch, but it is
 * listed so a command allowlist never rejects what the user can legally type.
 */
export const GLOBAL_FLAGS = [
  "--read-only",
  "--readonly",
  "--non-interactive",
  "--env",
  "--help",
  "--version",
] as const;

/**
 * The globals that may legally appear BEFORE the command word
 * (`kit --read-only check`, the form README.md and docs/THREAT_MODEL.md
 * document). `--version` / `--help` are excluded: as the first token they mean
 * the top-level version/help command, and cli.ts dispatches them as such.
 */
const GLOBAL_PREFIX_FLAGS = ["--read-only", "--readonly", "--non-interactive"] as const;

function isGlobalPrefixFlag(token: string): boolean {
  return (GLOBAL_PREFIX_FLAGS as readonly string[]).includes(token) || token.startsWith("--env=");
}

/**
 * Split leading global flags off the front of argv.
 *
 * `kit --read-only check verify-attestation` must reach cmdCheck with the same
 * POSITIONAL shape as `kit check verify-attestation` — command modules read
 * subcommands off raw indices (`process.argv[3] === "verify-attestation"`), so a
 * flag sitting in front of the command word shifts every one of them. Before
 * this split, `command = args[0]` was `--read-only` and kit answered "Unknown
 * command: --read-only" (exit 1) for the exact invocation its own README
 * documents.
 *
 * The flags are not dropped — callers re-append them after the positionals, so
 * `hasFlag(process.argv, "--read-only")` and every allowlist still see them.
 */
export function splitLeadingGlobalFlags(args: readonly string[]): {
  leading: string[];
  rest: string[];
} {
  let i = 0;
  while (i < args.length && isGlobalPrefixFlag(args[i])) i++;
  return { leading: args.slice(0, i), rest: args.slice(i) };
}
