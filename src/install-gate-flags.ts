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

/**
 * Bins the gate matches as argv0, plus wrappers. Used to find where a wrapper's own arguments
 * end: `nice -n 5 npm i x` and `sudo -u root npm i x` put a value after the wrapper's flag,
 * and `timeout 600` a positional. Skipping only the flags left `5` / `root` / `600` as argv0
 * and the install unseen (kit-research adversarial-battery-tier3, G05).
 */
const COMMAND_BINS = new Set([
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
  "python",
  "python3",
  "poetry",
  "pdm",
  "claude",
  "sh",
  "bash",
  "zsh",
  "dash",
]);

const startsCommand = (tok: string): boolean => {
  const base = binBase(tok);
  return COMMAND_BINS.has(base) || PREFIX_BINS.has(base) || /^[^\s=]+=/.test(tok);
};

/**
 * Index of the first token after a wrapper's flags AND values. Values are skipped only when a
 * known command or wrapper follows them anywhere later in the segment, so `sudo vim x` still
 * reads `vim` as the command. The search has no cap: a cap let a wrapper with more values than
 * the cap hide the install behind them. A known command after an unrelated one
 * (`sudo echo npm i x`) is now read as the command, which fails closed.
 */
export function skipWrapperArgs(tokens: string[], i: number): number {
  const flags = (k: number) => {
    while (k < tokens.length && tokens[k].startsWith("-")) k++;
    return k;
  };
  let k = flags(i);
  const start = k;
  while (k < tokens.length && !startsCommand(tokens[k])) k = flags(k + 1);
  return k < tokens.length ? k : start;
}

/**
 * Options a package manager takes BEFORE its subcommand with a separate value
 * (`npm --prefix <dir> install x`). Only the separate form needs listing: `--prefix=<dir>`
 * is one token and is dropped as a flag. Without this, the value read as the subcommand and
 * the install passed with no output (kit-research home-repo-pattern-vs-kit, 8 of 8 forms).
 * An option NOT listed here is handled fail-closed by `hiddenVerb`.
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
const GLOBAL_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["--prefix", "-C", "--loglevel", "--cache", "--workspace", "-w", "--location"]),
  pnpm: new Set(["-C", "--dir", "--filter", "-F", "--loglevel", "--reporter"]),
  yarn: new Set(["--cwd", "--modules-folder", "--cache-folder", "--mutex", "--network-timeout"]),
  bun: new Set(["--cwd"]),
  uv: new Set(["--directory", "--project", "--cache-dir", "--config-file", "--color"]),
  pip: new Set(PIP_VALUE_FLAGS),
  pip3: new Set(PIP_VALUE_FLAGS),
  pipx: new Set(["--python", "--pip-args", "--log-dir"]),
  poetry: new Set(["-C", "--directory", "-P", "--project"]),
  pdm: new Set(["-p", "--project", "-c", "--config"]),
};

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
    else if (isValueFlag(flag))
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
  const unknown = foldGlobalFlags(tokens, isValueFlag);
  if (!unknown) return null;
  const verbs = positionals(tokens);
  if (!verbs.slice(2).some((t) => FETCH_VERB_RE.test(t))) return null;
  // The subcommand slot holds a fetch verb the matchers triage: the option took no value.
  // Any other verb there (`run`, `tool`, ...) may be the option's value, and the fetch verb
  // behind it the real command, so it is not safe.
  if (FETCH_VERB_RE.test(verbs[1] ?? "")) return null;
  return `global-option:${tokens[0]} ${unknown} ${verbs[1]}`;
}
