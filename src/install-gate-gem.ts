/**
 * `gem install <name>` and `bundle add <name>` go through the install gate like `npm install`.
 *
 * `kit triage gem` exists (#779), but the bash gate passed both commands with no output.
 * strutil-core 1.0.1 ran a credential-stealing worm from its `extconf.rb` during `gem install`
 * (kit-research `strutil-core-gem-worm-vs-kit`). The owner chose to gate, not to print a notice:
 * each named gem becomes a `gem:<name>[@version]` ref that `gateInstall` triages, and an install
 * kit cannot reduce to a RubyGems name and exact version is refused (fail-closed).
 *
 * Local `.gem` files and paths are not registry fetches and are skipped, as local npm tarballs
 * are. A bare `bundle install` or `gem install -g` (the Gemfile's own dependencies) is out of
 * scope here. Pure.
 */

const GEM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXACT_VERSION = /^=?\s*([0-9][0-9A-Za-z.-]*)$/;

/** Options that take the next word as their value. */
const GEM_VALUE = new Set([
  "-v",
  "--version",
  "-i",
  "--install-dir",
  "-n",
  "--bindir",
  "-P",
  "--trust-policy",
  "--platform",
  "--build-root",
  "--target-rbconfig",
  "-g",
  "--group",
  "-r",
  "--require",
  "--branch",
  "--ref",
  "--path",
  "--glob",
]);
/** Options that fetch from somewhere other than rubygems.org, or install what no name says. */
const GEM_SOURCE = new Set([
  "-s",
  "--source",
  "--clear-sources",
  "--git",
  "--github",
  "--file",
  "--pre",
  "--prerelease",
]);

export interface GemProbe {
  isInstall: boolean;
  refs: string[];
  unverifiable: string[];
}

/** The index of the first argument of `gem install|i` or `bundle add`, else -1. */
function argStart(tokens: readonly string[]): number {
  const [bin, verb] = tokens;
  if (bin === "gem" && (verb === "install" || verb === "i")) return 2;
  if ((bin === "bundle" || bin === "bundler") && verb === "add") return 2;
  return -1;
}

/** `name`, `name:version` (gem's own spelling), or a local `.gem` file / path (null). */
function gemOperand(tok: string): { name: string; version?: string } | "local" | null {
  if (/^[./~]/.test(tok) || /\.gem$/i.test(tok)) return "local";
  const [name, version, extra] = tok.split(":");
  if (extra !== undefined || !GEM_NAME.test(name ?? "")) return null;
  if (version === undefined) return { name };
  return EXACT_VERSION.test(version) ? { name, version } : null;
}

interface GemArgs {
  operands: string[];
  version?: string;
  refused: string[];
}

const VALUELESS = new Set(["--clear-sources", "--pre", "--prerelease"]);

/** A known option: record what it says on `out`. Returns the words it used, or 0 if unknown. */
function readOption(bin: string, args: readonly string[], i: number, out: GemArgs): number {
  const tok = args[i]!;
  const [flag, glued] = tok.startsWith("--") ? tok.split(/=(.*)/s, 2) : [tok, undefined];
  const source = GEM_SOURCE.has(flag!);
  // `gem install -g <file>` installs a deps file's gems; `bundle add -g` is `--group`.
  if (source || (bin === "gem" && flag === "-g")) out.refused.push(`gem-source:${flag}`);
  if (!source && !GEM_VALUE.has(flag!)) return 0;
  const takesNext = glued === undefined && !VALUELESS.has(flag!);
  if (flag === "-v" || flag === "--version") out.version = glued ?? args[i + 1];
  return takesNext ? 2 : 1;
}

function readArgs(bin: string, args: readonly string[]): GemArgs {
  const out: GemArgs = { operands: [], refused: [] };
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--") break; // gem passes the rest to the extension build
    const used = readOption(bin, args, i, out);
    if (used > 0) {
      i += used - 1;
      continue;
    }
    const shortVersion = /^-v(.+)$/.exec(tok);
    if (shortVersion) out.version = shortVersion[1];
    else if (!tok.startsWith("-")) out.operands.push(tok);
  }
  return out;
}

/**
 * Record a `gem install` / `bundle add` segment on `probe`. `tokens` are the segment's words,
 * de-quoted, with the binary's base name first. Returns true when the segment was one.
 */
export function gemInstall(tokens: readonly string[], probe: GemProbe): boolean {
  const start = argStart(tokens);
  if (start < 0) return false;
  const { operands, version, refused } = readArgs(tokens[0]!, tokens.slice(start));
  const exact = version === undefined ? undefined : EXACT_VERSION.exec(version.trim())?.[1];
  if (version !== undefined && !exact) refused.push(`gem-version:${version}`);
  const refs: string[] = [];
  for (const tok of operands) {
    const operand = gemOperand(tok);
    if (operand === "local") continue;
    const pinned = operand && (operand.version ?? exact);
    if (!operand) refused.push(`gem:${tok}`);
    else refs.push(pinned ? `gem:${operand.name}@${pinned}` : `gem:${operand.name}`);
  }
  if (refused.length > 0 || refs.length > 0) probe.isInstall = true;
  probe.refs.push(...refs);
  probe.unverifiable.push(...refused);
  return true;
}
