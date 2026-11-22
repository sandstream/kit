/**
 * `cargo install <crate>` and `cargo binstall <crate>` go through the install gate like `npm install`.
 *
 * Measured before this file: `npm i -g @el4cteo/fast-anything` was refused on the 14-day cooling
 * hold while `cargo install fast-anything`, the same one-day-old program, left `kit gate-bash`
 * with exit 0. The owner chose to gate every install door. Each named crate becomes a
 * `crate:<name>[@version]` ref that `gateInstall` triages (`kit triage cargo`), and an install kit
 * cannot reduce to a crates.io name and exact version is refused (fail-closed).
 *
 * `cargo install --path <dir>` and a bare `cargo install` build what is already on disk: no
 * registry fetch, so they pass. `--git`, `--registry`, `--index` and `--config` name a source
 * other than crates.io, which crate triage does not read: refused as `cargo-source:`. Pure.
 */
import type { GemProbe } from "./install-gate-gem.js";

const CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const EXACT_VERSION = /^=?([0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*)$/;

/** Options that take the next word as their value (cargo's own, `install` and `binstall`). */
const CARGO_VALUE = new Set([
  "--version",
  "--vers",
  "--path",
  "--root",
  "-j",
  "--jobs",
  "--profile",
  "--target",
  "--targets",
  "--target-dir",
  "-F",
  "--features",
  "--bin",
  "--example",
  "--color",
  "-Z",
  "-C",
  "--explain",
  "--lockfile-path",
  "--message-format",
  "--install-path",
  "--bin-dir",
  "--pkg-fmt",
  "--strategies",
  "--disable-strategies",
  "--rate-limit",
  "--min-tls-version",
  "--log-level",
  "--github-token",
  "--branch",
  "--tag",
  "--rev",
]);
/** Options that fetch from somewhere other than crates.io; each takes a value. */
const CARGO_SOURCE = new Set([
  "--git",
  "--registry",
  "--index",
  "--config",
  "--pkg-url",
  "--manifest-path",
]);
/** Environment that moves cargo's registry or replaces its source. */
const CARGO_SOURCE_ENV = /^CARGO_(REGISTRIES_\w+_INDEX|REGISTRY_DEFAULT|SOURCE_)/;

interface CargoArgs {
  /** The subcommand first, then what it was given. */
  operands: string[];
  version?: string;
  local: boolean;
  refused: string[];
}

/** A known option: record what it says on `out`. Returns the words it used, or 0 if unknown. */
function readOption(args: readonly string[], i: number, out: CargoArgs): number {
  const [flag, glued] = args[i]!.startsWith("--") ? args[i]!.split(/=(.*)/s, 2) : [args[i]!];
  const source = CARGO_SOURCE.has(flag!);
  if (source) out.refused.push(`cargo-source:${flag}`);
  if (!source && !CARGO_VALUE.has(flag!)) return 0;
  if (flag === "--path") out.local = true;
  if (flag === "--version" || flag === "--vers") out.version = glued ?? args[i + 1];
  return glued === undefined ? 2 : 1;
}

function readArgs(args: readonly string[]): CargoArgs {
  const out: CargoArgs = { operands: [], local: false, refused: [] };
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--") break; // the rest goes to rustc or the program
    const used = readOption(args, i, out);
    if (used > 0) i += used - 1;
    else if (!tok.startsWith("-") && !tok.startsWith("+")) out.operands.push(tok);
  }
  return out;
}

/** `name` or `name@version` as a ref, or null when it is not a crates.io name and exact version. */
function crateRef(tok: string, version: string | undefined): string | null {
  const [name, own, extra] = tok.split("@");
  if (extra !== undefined || !CRATE_NAME.test(name ?? "")) return null;
  if (own === undefined) return version ? `crate:${name}@${version}` : `crate:${name}`;
  const exact = EXACT_VERSION.exec(own)?.[1];
  return exact ? `crate:${name}@${exact}` : null;
}

/** The crates a `cargo install` / `cargo binstall` names and its options, or null for any other command. */
function installArgs(tokens: readonly string[]): { args: CargoArgs; crates: string[] } | null {
  // `cargo-binstall <crate>` is the plugin run directly: it has no subcommand word.
  if (tokens[0] === "cargo-binstall") {
    const args = readArgs(tokens.slice(1));
    return { args, crates: args.operands };
  }
  if (tokens[0] !== "cargo") return null;
  const args = readArgs(tokens.slice(1));
  const verb = args.operands[0];
  if (verb !== "install" && verb !== "binstall") return null;
  return { args, crates: args.operands.slice(1) };
}

/**
 * Record a `cargo install` / `cargo binstall` segment on `probe`. `tokens` are the segment's
 * words, de-quoted, with the binary's base name first; `env` holds the words before the command
 * (assignments and wrappers). Returns true when the segment was one.
 */
export function cargoInstall(
  tokens: readonly string[],
  probe: GemProbe,
  env: readonly string[] = [],
): boolean {
  const install = installArgs(tokens);
  if (!install) return false;
  const { args, crates } = install;
  const refused = [...args.refused];
  const exact = args.version === undefined ? undefined : EXACT_VERSION.exec(args.version)?.[1];
  if (args.version !== undefined && !exact) refused.push(`cargo-version:${args.version}`);
  const refs: string[] = [];
  // `--path` builds a directory on disk: whatever else is named, nothing comes from the registry.
  for (const tok of args.local ? [] : crates) {
    const ref = crateRef(tok, exact);
    if (ref) refs.push(ref);
    else refused.push(`crate:${tok}`);
  }
  if (refs.length === 0 && refused.length === 0) return true; // a local build: nothing fetched
  for (const word of env)
    if (CARGO_SOURCE_ENV.test(word)) refused.push(`cargo-source:${word.split("=", 1)[0]}`);
  probe.isInstall = true;
  probe.refs.push(...refs);
  probe.unverifiable.push(...refused);
  return true;
}
