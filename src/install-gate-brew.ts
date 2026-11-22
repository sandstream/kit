/**
 * `brew install <formula|cask>` goes through the install gate like `npm install`.
 *
 * `kit triage brew` has existed since the Homebrew channel was added, but the bash gate passed
 * `brew install` with no output. Each named formula or cask becomes a `brew:<name>` ref that
 * `gateInstall` triages, one triage per name. A cask is named `homebrew/cask/<token>`, Homebrew's
 * own full name for it, so the triage reads the cask and not a formula of the same name.
 *
 * A formula given as a file or a URL is a recipe kit has not read, and a `HOMEBREW_*_DOMAIN` or
 * `*_GIT_REMOTE` word moves the download off Homebrew's servers: both are refused as
 * `brew-source:`. Pure.
 */
import type { GemProbe } from "./install-gate-gem.js";

/** The names `kit triage brew` accepts: a formula, `name@version`, or `owner/tap/name`. */
const BREW_NAME = /^[a-z0-9][a-z0-9@/+._-]*$/i;
/** Options written with a separate value (`--appdir <dir>`); `--appdir=<dir>` is one word. */
const BREW_VALUE = /^--(?:[a-z0-9-]+dir|language|cc|env|bottle-arch)$/;
const BREW_SOURCE_ENV = /^HOMEBREW_[A-Z_]*(DOMAIN|GIT_REMOTE)=/;

interface BrewArgs {
  names: string[];
  cask: boolean;
}

/** The names after `brew install`, or null when the command is not one. */
function installArgs(tokens: readonly string[]): BrewArgs | null {
  if (tokens[0] !== "brew") return null;
  const out: BrewArgs = { names: [], cask: false };
  let verb: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "--cask" || tok === "--casks") out.cask = true;
    if (BREW_VALUE.test(tok)) i++;
    if (tok.startsWith("-")) continue;
    if (verb === undefined) verb = tok;
    else out.names.push(tok);
    if (verb !== "install") return null;
  }
  return verb === "install" ? out : null;
}

/** A formula file or URL: a recipe from outside Homebrew's taps. */
function isRecipe(tok: string): boolean {
  return tok.includes("://") || /^[./~]/.test(tok) || /\.rb$/i.test(tok);
}

/**
 * Record a `brew install` segment on `probe`. `tokens` are the segment's words, de-quoted, with
 * the binary's base name first; `env` holds the words before the command (assignments and
 * wrappers). Returns true when the segment was one.
 */
export function brewInstall(
  tokens: readonly string[],
  probe: GemProbe,
  env: readonly string[] = [],
): boolean {
  const args = installArgs(tokens);
  if (!args) return false;
  if (args.names.length === 0) return true;
  const refused: string[] = [];
  for (const tok of args.names) {
    if (isRecipe(tok)) refused.push(`brew-source:${tok}`);
    else if (!BREW_NAME.test(tok)) refused.push(`brew:${tok}`);
    else
      probe.refs.push(
        args.cask && !tok.includes("/") ? `brew:homebrew/cask/${tok}` : `brew:${tok}`,
      );
  }
  for (const word of env)
    if (BREW_SOURCE_ENV.test(word)) refused.push(`brew-source:${word.split("=", 1)[0]}`);
  probe.isInstall = true;
  probe.unverifiable.push(...refused);
  return true;
}
