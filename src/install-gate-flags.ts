/**
 * How the install gate finds the real command in a Bash segment: the bin name as the shell
 * resolves it, the wrappers in front of it with their own flags and values, and a package
 * manager's options before its subcommand. Split from `install-gate.ts`, which imports it.
 * Pure: no I/O.
 *
 * kit-research `adversarial-battery-tier3-gate-attacks` found eleven installs that passed the
 * gate silently because a value sat where the command or subcommand was expected
 * (`npm --prefix <dir> install x`, `nice -n 5 npm i x`, `timeout 600 npm i x`).
 */

import { wrapperCommandStart } from "./install-gate-wrappers.js";

/**
 * The command NAME as the shell would resolve it for matching: drop a leading `\`
 * (the standard alias-bypass, `\npm` runs the real npm) and take the basename
 * (`/usr/bin/npm`, `./node_modules/.bin/pnpm` → `npm`/`pnpm`). Without this the exact
 * `t[0] === "npm"` matchers were defeated by any absolute/relative path or `\` escape.
 */
export function binBase(tok: string): string {
  const noEsc = tok.replace(/^\\+/, "");
  const base = noEsc.split("/").pop();
  const resolved = base && base.length > 0 ? base : noEsc;
  // Strip a trailing `@version` — corepack's `pnpm@9` / `yarn@1.22.19` dispatch syntax leaves
  // that as argv0 after the wrapper is stripped, so `t[0] === "pnpm"` never matched. Only bin
  // names flow through binBase (never package args), so a scoped/versioned package like
  // `@scope/pkg@1` is unaffected.
  return resolved.replace(/@.+$/, "");
}

/**
 * Wrapper binaries that prefix a real command without changing what it is
 * (`env FOO=bar npm i x`, `sudo npm i x`). We strip a leading run of these plus
 * any `VAR=value` env assignments so the matcher sees the actual package manager.
 * A bare `VAR=value npm i evil` would otherwise tokenize to t[0]="VAR=value" and
 * defeat every matcher — a full gate bypass.
 */
export const PREFIX_BINS = new Set([
  "env",
  "sudo",
  "command",
  "builtin",
  "exec",
  "nice",
  "time",
  "nohup",
  "doas",
  "setsid",
  "stdbuf",
  // corepack ships with Node and dispatches to the pinned package manager, so
  // `corepack pnpm add evil` really runs `pnpm add evil`. It's a pure wrapper; stripping
  // it exposes the real manager. Its own subcommands (enable/install/use) reduce to a
  // bare verb no matcher claims, so no false positive.
  "corepack",
  // Wrappers whose own syntax puts a VALUE or a positional before the command:
  // `timeout 600 npm i x`, `ionice -c 3 npm i x`, `chrt 10 npm i x`, `taskset 0x1 npm i x`,
  // `flock /tmp/l npm i x`. Their values are skipped by `skipWrapperArgs`.
  "timeout",
  "ionice",
  "chrt",
  "taskset",
  "flock",
]);

/** Consume only the wrapper's arguments. Never search its child's argument list. */
export function skipWrapperArgs(tokens: string[], i: number, unverifiable: string[] = []): number {
  return wrapperCommandStart(tokens, i, binBase(tokens[i - 1] ?? ""), unverifiable);
}

/**
 * Options a package manager takes BEFORE its subcommand with a separate value
 * (`npm --prefix <dir> install x`). Only the separate form needs listing: `--prefix=<dir>`
 * is one token and is dropped as a flag. Without this, the value read as the subcommand and
 * the install passed with no output (kit-research home-repo-pattern-vs-kit, 8 of 8 forms).
 * An option NOT listed here is handled fail-closed by `hiddenVerb`. An option that can carry a
 * registry or a config file (`uv --config-file`, `pdm -c`, `pipx --pip-args`) is left out on
 * purpose: folding it would hide its value from the registry-redirect reader.
 */
const PIP_VALUE_FLAGS = [
  "--proxy",
  "--cache-dir",
  "--log",
  "--timeout",
  "--retries",
  "--cert",
  "--client-cert",
  "--trusted-host",
  "--exists-action",
  "--python",
  "--keyring-provider",
  "--use-feature",
  "--use-deprecated",
];
const UV_GLOBAL_VALUE_FLAGS = new Set(["--directory", "--project", "--cache-dir", "--color"]);
const GLOBAL_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["--prefix", "-C", "--loglevel", "--cache", "--workspace", "-w", "--location"]),
  pnpm: new Set(["-C", "--dir", "--filter", "-F", "--loglevel", "--reporter"]),
  yarn: new Set(["--cwd", "--modules-folder", "--cache-folder", "--mutex", "--network-timeout"]),
  bun: new Set(["--cwd"]),
  uv: UV_GLOBAL_VALUE_FLAGS,
  uvx: UV_GLOBAL_VALUE_FLAGS,
  pip: new Set(PIP_VALUE_FLAGS),
  pip3: new Set(PIP_VALUE_FLAGS),
  pipx: new Set(["--python", "--log-dir"]),
  poetry: new Set(["-C", "--directory", "-P", "--project"]),
  pdm: new Set(["-p", "--project"]),
};

/**
 * Options that name a config file, where the gate's generic reader would take `-c <value>` as a
 * constraints file (pip's meaning). For these managers the file may set the registry, so the
 * option stays unknown and the rule fails closed.
 */
const CONFIG_FILE_FLAGS: Record<string, ReadonlySet<string>> = {
  pdm: new Set(["-c", "--config"]),
  uv: new Set(["--config-file"]),
  uvx: new Set(["--config-file"]),
  pipx: new Set(["--pip-args"]),
};

/** Name an option that can select an uninspected package source. Never return its value. */
export function sourceConfigurationFlag(tokens: readonly string[]): string | null {
  const flags = CONFIG_FILE_FLAGS[tokens[0]];
  if (!flags) return null;
  const positionals: string[] = [];
  let uncertain = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") break;
    const name = sourceOption(tokens[0], token, flags);
    if (name) return name;
    if (token.startsWith("-")) {
      const width = managerOptionWidth(tokens[0], token);
      uncertain ||= width < 0;
      i += Math.max(width, 0);
      continue;
    }
    positionals.push(token);
    if (!uncertain && childCommandReached(tokens[0], positionals)) break;
  }
  return null;
}

function sourceOption(manager: string, token: string, flags: ReadonlySet<string>): string | null {
  const name = token.split("=", 1)[0];
  if (flags.has(name)) return name;
  // PDM's -v, -q and -g take no value. A following -c consumes the rest of the group.
  return manager === "pdm" && /^-[vqg]*c/.test(token) ? "-c" : null;
}

const RUNNER_VALUE_FLAGS = new Set([
  "--python",
  "-p",
  "--with",
  "--with-editable",
  "--with-requirements",
  "--from",
  "--spec",
  "--env-file",
  "--index",
  "--index-url",
  "--extra-index-url",
  "--default-index",
  "--group",
  "--no-group",
  "--only-group",
  "--extra",
  "--no-extra",
  "--package",
]);

const RUNNER_BOOLEAN_FLAGS = new Set([
  "--offline",
  "--no-sync",
  "--frozen",
  "--locked",
  "--no-project",
  "--isolated",
  "--no-config",
  "--no-cache",
  "--no-progress",
  "--quiet",
  "--verbose",
]);

/** Unknown option arity cannot establish where the child's arguments start. */
function managerOptionWidth(manager: string, token: string): number {
  if (token.includes("=")) return 0;
  if (GLOBAL_VALUE_FLAGS[manager]?.has(token) || RUNNER_VALUE_FLAGS.has(token)) return 1;
  if (RUNNER_BOOLEAN_FLAGS.has(token) || /^-[vq]+$/.test(token)) return 0;
  return -1;
}

/** A runner's first operand starts the child's arguments. Flags there belong to the child. */
function childCommandReached(manager: string, pos: string[]): boolean {
  if (manager === "uvx") return pos.length === 1;
  if (pos[0] === "run") return pos.length === 2;
  return manager === "uv" && pos[0] === "tool" && pos[1] === "run" && pos.length === 3;
}

/**
 * Package managers the fail-closed rule covers. One that has no entry above reads every option
 * as unknown, which is the safe side. A command that is not a package manager is not covered:
 * `git --foo bar install` is not an install.
 */
const MANAGER_BINS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "bunx",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "uvx",
  "poetry",
  "pdm",
]);

/** Verbs whose matcher triages every argument as a package: the only ones that clear an option. */
const INSTALLER_VERB_RE = /^(install|i|add|install-test|it|update|upgrade|ci|clean-install)$/;
/** Verbs that fetch a package, looked for after an ambiguous leading option. */
const FETCH_VERB_RE =
  /^(install|i|add|install-test|it|update|upgrade|ci|clean-install|exec|x|dlx|create|init)$/;

/**
 * Fold a known value-taking global option and its value into one `--flag=value` token, in
 * place, so the subcommand lands in its slot. Returns the first unknown option that is
 * followed by a non-flag token, which may have swallowed it as a value, or "".
 */
function foldGlobalFlags(tokens: string[], isValueFlag: (flag: string) => boolean): string {
  if (!MANAGER_BINS.has(tokens[0])) return "";
  const known = GLOBAL_VALUE_FLAGS[tokens[0]] ?? new Set<string>();
  let unknown = "";
  let i = 1;
  for (; i < tokens.length && tokens[i].startsWith("-"); i++) {
    const flag = tokens[i];
    const next = tokens[i + 1];
    if (flag.includes("=") || next === undefined || next.startsWith("-")) continue;
    if (known.has(flag)) tokens.splice(i, 2, `${flag}=${next}`);
    else if (isValueFlag(flag) && !CONFIG_FILE_FLAGS[tokens[0]]?.has(flag))
      i++; // its value; the caller's positional and redirect readers take the pair
    else if (!unknown) unknown = flag;
  }
  return unknown;
}

/**
 * Fail-closed on an option kit does not know, before the subcommand: `npm --foo bar install x`.
 * kit cannot tell whether `--foo` takes `bar` as its value, so when the subcommand slot holds no
 * fetch verb and a fetch verb follows, the install is unverifiable. Folds known options in
 * `tokens` in place either way. Returns the `global-option:` reason, or null.
 */
export function hiddenVerb(
  tokens: string[],
  positionals: (tokens: string[]) => string[],
  isValueFlag: (flag: string) => boolean,
): string | null {
  const configFlag = sourceConfigurationFlag(tokens);
  if (configFlag && tokens.some((token) => FETCH_VERB_RE.test(token) || token === "run")) {
    return `global-option:${tokens[0]} ${configFlag} source-configuration`;
  }
  const unknown = foldGlobalFlags(tokens, isValueFlag);
  if (!unknown) return null;
  const verbs = positionals(tokens);
  // The caller's positional reader drops the file after a `-c`, so a config option is judged on
  // every positional: a fetch verb anywhere makes the install unverifiable.
  if (CONFIG_FILE_FLAGS[tokens[0]]?.has(unknown)) {
    return verbs.some((t) => FETCH_VERB_RE.test(t))
      ? `global-option:${tokens[0]} ${unknown} config-file`
      : null;
  }
  if (!verbs.slice(2).some((t) => FETCH_VERB_RE.test(t))) return null;
  // The subcommand slot holds an installer verb whose matcher triages every argument: the option
  // took no value. Any other verb there (`run`, `tool`, and also the runners `exec`, `dlx`,
  // `create`, `init`, which triage only their first argument) may be the option's value, and the
  // fetch verb behind it the real command, so it is not safe.
  if (INSTALLER_VERB_RE.test(verbs[1] ?? "")) return null;
  return `global-option:${tokens[0]} ${unknown} ${verbs[1]}`;
}
