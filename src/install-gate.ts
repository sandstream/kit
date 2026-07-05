/**
 * Install-gate — make "installs nothing untriaged" true even in agent auto-mode.
 *
 * A rules-file instruction ("run kit triage before installing") only ADVISES; an
 * agent in auto/bypass mode can run `npm install evil` directly and the malicious
 * postinstall fires immediately — before any commit, so git hooks are too late.
 * The only real gate is a Claude Code (or Codex / Amazon Q) `PreToolUse` hook that
 * inspects the pending Bash command and BLOCKS it (exit 2) unless the package is
 * triaged.
 *
 * This module is the deterministic core: `parseInstallCommand` turns a raw Bash
 * string into kit triage refs (npm:/pip:), and `decideBashGate` triages each via
 * the existing `gateInstall` and returns a block/allow verdict. Pure + injectable
 * (no I/O here); the CLI wires it to stdin/exit-codes.
 *
 * Scope: the ecosystems kit can actually triage — npm (npm/pnpm/yarn/bun + npx)
 * and PyPI (pip/pip3/pipx/uv). Ecosystems kit has no triage for (cargo/go/gem/
 * brew) are passed through, NOT blocked, so the gate stays usable; that is an
 * honest scope limit, documented as such. Within scope it is FAIL-CLOSED: an
 * install whose target we cannot reduce to a clean registry name is blocked.
 */
import { gateInstall, type GateVerdict, type GateDeps } from "./triage-gate.js";

export interface InstallProbe {
  /** A package-manager add/install in a covered ecosystem was detected. */
  isInstall: boolean;
  /** kit triage refs to gate, e.g. ["npm:express", "pip:requests"]. */
  refs: string[];
  /** Covered-ecosystem install args we could not reduce to a clean ref (fail-closed → block). */
  unverifiable: string[];
}

/** Shell operators that separate independent commands in one Bash string. */
// Command separators. Includes single `&` (job-control background) and `|&` so an
// install placed AFTER a background/`&` op is still its own segment — `: & npm i
// evil` and `true |& npm i evil` previously left the install non-leading and unseen.
// NO surrounding `\s*`: padding the separator with `\s*` makes String.split O(N²) on a
// long whitespace run (each start position greedily consumes the run, fails, backtracks) —
// a hot-path DoS on a whitespace-padded command. `scanSegment` trims each segment, so the
// split output is byte-identical without the padding, and matching is linear.
const SEGMENT_SPLIT = /&&|\|\||;|\||&|\n/;

// Leading shell keywords / grouping tokens that precede a real command without
// changing it. Stripped like PREFIX_BINS so `then npm i evil` / `{ npm i evil; }` /
// `if true; then npm i …` don't hide the package manager from the head-anchored
// matcher. `eval`/`xargs` are here for the UNQUOTED form; the quoted form is
// recursed into by nestedCommands.
const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "{",
  "}",
  "(",
  ")",
  "!",
  "eval",
  "xargs",
]);

/** A token is a flag (skip it) — `-g`, `--save-dev`, etc. */
function isFlag(tok: string): boolean {
  return tok.startsWith("-");
}

/**
 * Package(s) that REPLACE a runner's positional-as-package: `-p`/`--package` (npx),
 * `--spec` (pipx), `--from` (uvx). For these the flag value is the FETCHED package and
 * the positional is the command to run — so `--package=evil somecmd` must gate `evil`,
 * not `somecmd`. Returns the values found (equals- and space-separated forms).
 */
function replacePackageFlags(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const eq = rest[i].match(/^(?:-p|--package|--spec|--from)=(.+)$/);
    if (eq) {
      out.push(eq[1]);
      continue;
    }
    if (/^(?:-p|--package|--spec|--from)$/.test(rest[i])) {
      if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("-")) out.push(rest[i + 1]);
      i++;
    }
  }
  return out;
}

/**
 * ADDITIONAL packages a runner fetches via `--with` (`uv run --with evil script`,
 * `uvx --with evil tool`): these install alongside the primary package/positional, so
 * they are ALWAYS gated and never replace it. Returns the values found.
 */
function withPackageFlags(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const eq = rest[i].match(/^--with=(.+)$/);
    if (eq) {
      out.push(eq[1]);
      continue;
    }
    if (rest[i] === "--with") {
      if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("-")) out.push(rest[i + 1]);
      i++;
    }
  }
  return out;
}

/**
 * Remove quote characters from a token, matching how the shell strips quotes WITHIN a
 * word — `n"p"m` → `npm`, `i'nstall'` → `install`, `'pkg'` → `pkg`. The old version only
 * unwrapped quotes around a WHOLE token, so intra-word quoting (`n"p"m install evil`) hid
 * the binary/subcommand from every matcher — a full gate bypass for any package manager.
 * A backslash-escaped quote (`\"`) is a literal quote in an unquoted word, so keep it.
 */
function dequote(tok: string): string {
  // Protect an escaped quote as a NON-quote marker BEFORE stripping unescaped quotes —
  // the old `\x00$1` kept the quote char, so step 2's quote-strip removed it and step 3's
  // restore never matched, leaking a bare `\x00` into the token (and into block-reason
  // strings). The marker carries the quote type so it restores exactly.
  return tok
    .replace(/\\(['"])/g, (_, q) => (q === '"' ? "\x00D" : "\x00S"))
    .replace(/['"]/g, "")
    .replace(/\x00D/g, '"')
    .replace(/\x00S/g, "'");
}

/**
 * The command NAME as the shell would resolve it for matching: drop a leading `\`
 * (the standard alias-bypass, `\npm` runs the real npm) and take the basename
 * (`/usr/bin/npm`, `./node_modules/.bin/pnpm` → `npm`/`pnpm`). Without this the exact
 * `t[0] === "npm"` matchers were defeated by any absolute/relative path or `\` escape.
 */
function binBase(tok: string): string {
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
const PREFIX_BINS = new Set([
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
]);

/** Drop leading wrapper bins + `VAR=value` env assignments, returning the real argv. */
function stripCommandPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    // Any leading `NAME=VALUE` is a shell env assignment — including names with
    // non-word chars (`env 'a:b=1' npm i evil`, `npm_config_@scope:registry=…`),
    // which a stricter [A-Za-z_]\w* regex left as argv[0], hiding the install
    // entirely. Broadened so no bogus assignment can mask the package manager.
    if (/^[^\s=]+=/.test(t)) {
      i++; // VAR=value env assignment
      continue;
    }
    // Compare wrapper/keyword membership on the resolved basename, so a path- or
    // backslash-qualified wrapper (`/usr/bin/sudo`, `\command`) is still stripped.
    const base = binBase(t);
    if (PREFIX_BINS.has(base)) {
      i++;
      while (i < tokens.length && tokens[i].startsWith("-")) i++; // skip the wrapper's own flags
      continue;
    }
    // Leading shell keyword / grouping token (then/do/{/eval/…) → skip; also handle
    // a grouping char glued to the next token (`{npm`, `(npm`).
    if (SHELL_KEYWORDS.has(t)) {
      i++;
      continue;
    }
    if (/^[{(!]+/.test(t) && !SHELL_KEYWORDS.has(t)) {
      // strip a leading run of glued grouping chars, keep the rest as a token
      tokens[i] = t.replace(/^[{(!]+/, "");
      if (tokens[i] === "") {
        i++;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * Commands hidden inside a subshell (`$(…)`, backticks) or a shell `-c` argument
 * (`sh -c 'npm i evil'`). The segment splitter doesn't recurse into these, so an
 * install smuggled through a wrapper would slip past. We extract the inner command
 * text (bounded, to stay linear-time on hostile input) and gate it like a
 * top-level one. Fail-closed.
 */
// A quoted body that does NOT stop at a backslash-ESCAPED quote: a `\"` inside a
// double-quoted arg is a literal quote, not the closer (`sh -c "sh -c \"npm i evil\""`).
// The two alternatives are mutually exclusive (a char is either a backslash — first alt,
// consuming it plus the next char — or a non-backslash), so there is no quantifier
// ambiguity and no catastrophic backtracking. Bounded to stay linear on hostile input.
const QUOTED_BODY = /(['"])((?:\\[\s\S]|[^\\]){1,2000}?)\1/;

/** Unescape a double-quoted shell body (`\"`→`"`, `\\`→`\`, `\$`→`$`) so an install hidden
 *  behind escaped quotes is re-scannable after extraction. Single-quoted bodies keep
 *  backslashes literal (shell semantics), so only unescape when the delimiter was `"`. */
function pushQuoted(out: string[], quote: string, body: string): void {
  out.push(quote === '"' ? body.replace(/\\([\s\S])/g, "$1") : body);
}

function nestedCommands(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/\$\(([^()]{1,2000})\)/g)) out.push(m[1]);
  for (const m of command.matchAll(/`([^`]{1,2000})`/g)) out.push(m[1]);
  // `sh -c '…'` / `bash -lc "…"` / `bash -euo pipefail -c $'…'` — the quoted arg to a SHELL's
  // `-c` is executed, so recurse into it. Anchored to a shell binary (optionally path-qualified,
  // with flags between) rather than any `-c` anywhere: a bare `-c` in an unrelated command's
  // quoted argument (`git commit -m "…-c…"`) isn't a shell invocation and must not be gated.
  // `-[A-Za-z]*c[A-Za-z]*` matches `-c` glued into a short-flag cluster (`-lc`/`-xc`/`-cl`,
  // the common cron/CI form); `\$?` accepts an ANSI-C/locale `$'…'`/`$"…"` command arg.
  for (const m of command.matchAll(
    new RegExp(
      /(?:^|\s)(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|ash|fish)(?:\s+\S+)*?\s+-[A-Za-z]*c[A-Za-z]*\s+\$?/
        .source + QUOTED_BODY.source,
      "g",
    ),
  )) {
    pushQuoted(out, m[1], m[2]);
  }
  // `eval '…'` / `xargs "…"` — the QUOTED script arg (the unquoted form is handled
  // by SHELL_KEYWORDS stripping). Recurse so a quoted install can't hide behind eval.
  for (const m of command.matchAll(
    new RegExp(/\b(?:eval|xargs)\s+/.source + QUOTED_BODY.source, "g"),
  )) {
    pushQuoted(out, m[1], m[2]);
  }
  // Process substitution `<(…)` / `>(…)` — the inner command RUNS, so
  // `cat <(npm install evil)` must be gated. The splitter never enters these.
  for (const m of command.matchAll(/[<>]\(([^()]{1,2000})\)/g)) out.push(m[1]);
  // Here-string `<<< "npm i evil"` (quoted or bare word) — the operand is fed to a
  // shell (`bash <<< "npm i evil"`); recurse into it.
  for (const m of command.matchAll(new RegExp(/<<<\s*/.source + QUOTED_BODY.source, "g"))) {
    pushQuoted(out, m[1], m[2]);
  }
  for (const m of command.matchAll(/<<<\s*([^\s'"][^\n]{0,2000})/g)) out.push(m[1]);
  // `npm|pnpm|yarn|bun exec|dlx|x  -c/--call '<shell string>'` runs the string in a shell
  // (with node_modules/.bin on PATH), so an install inside it really executes — recurse.
  // The runner path itself gates nothing positional here (hasExecCallFlag), so the package
  // is only seen via this recursion. `(?:@\S+)?` allows corepack's version-pinned dispatch
  // (`corepack pnpm@9 exec -c …`) — binBase strips the @version for the segment matcher, so
  // this recursion must match it too or the string is neither gated nor re-scanned.
  for (const m of command.matchAll(
    new RegExp(
      /(?:npm|pnpm|yarn|bun)(?:@\S+)?\s+(?:exec|dlx|x)\b[^\n]*?\s(?:--call|-c)(?:=|\s)\s*/.source +
        QUOTED_BODY.source,
      "g",
    ),
  )) {
    pushQuoted(out, m[1], m[2]);
  }
  // A package runner whose FIRST positional is itself a package manager
  // (`npx npm i evil`, `pnpm exec npm i evil`, `corepack pnpm@9 exec yarn add evil`) runs that
  // manager's install for real, but the runner path would gate only the manager name (npm:npm,
  // reputable → PASS) and miss the real package. Recurse from the inner manager so its args are
  // scanned as a command. Contrived but a genuine bypass; fail-closed.
  // Tolerate flags between the runner and the inner manager (`npx -y npm i evil`,
  // `npm exec -- npm i evil`). The two flag alternatives MUST be mutually exclusive — a
  // dash-led token (`-\S*`, covering `--`/`-x`/`-x=y`) vs a non-dash `key=value` env
  // assignment (`[^-\s]\S*=\S+`) — so a `-x=y` token can't match both and blow the group up
  // into 2^N parse paths (a catastrophic-backtracking ReDoS on this PreToolUse hot path).
  for (const m of command.matchAll(
    /(?:npx|bunx|(?:npm|pnpm|yarn|bun)(?:@\S+)?\s+(?:exec|dlx|x))\s+(?:(?:-\S*|[^-\s]\S*=\S+)\s+)*((?:npm|pnpm|yarn|bun|pip|pip3|pipx|uv|uvx|python|python3|poetry|pdm)(?:@\S+)?\s[^\n]{1,2000})/g,
  )) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Normalize runtime whitespace expansions to a real space BEFORE tokenizing. In any POSIX
 * shell `${IFS}`/`$IFS` (and ANSI-C `$'\t'`/`$'\n'`) expand to whitespace, so
 * `npm${IFS}i${IFS}evil` runs `npm i evil` — but a literal-`\s+` tokenizer keeps it one
 * token and every matcher misses it (the canonical word-split gate bypass). Collapsing them
 * first makes the real argv visible. `$IFS` is matched only as a whole var (not `$IFSx`).
 * The braced form allows any parameter-expansion operator (`${IFS:0:1}`, `${IFS%%x}`) — all
 * still expand to whitespace and word-split — while `$IFSx` stays a different variable.
 */
function normalizeShellWhitespace(command: string): string {
  return command
    .replace(/(["']?)\$\{IFS[^}]*\}\1/g, " ")
    .replace(/(["']?)\$IFS\1(?=[^A-Za-z0-9_]|$)/g, " ")
    .replace(/\$'(?:\\[tnr]| )'/g, " ");
}

// Env vars / flags that REDIRECT where a package manager fetches from. If any is
// present (pointing anywhere but a known default), the reputable public NAME we
// would triage is NOT what gets installed — so the whole command is unverifiable
// (fail-closed), closing the "triage PASS while pulling attacker code" bypass.
const SOURCE_ENV_RE =
  /^(npm_config_.*registry|npm_config_userconfig|npm_config_globalconfig|.*_registry|yarn_npm_registry_server|pip_index_url|pip_extra_index_url|pip_config_file|uv_index.*|uv_default_index|bun_config_registry)$/i;
const SOURCE_FLAG_RE =
  /^(--registry|--index-url|--index|--extra-index-url|--default-index|--userconfig|--globalconfig|-i)$/i;
// pip flags whose VALUE is a FILE/path, not a registry package — skip the value so
// `pip install -r requirements.txt` isn't mis-triaged as a package `requirements.txt`
// (a false positive that blocks a benign install and pushes users off the gate).
const REQUIREMENT_FLAG_RE = /^(-r|--requirement|-e|--editable|-c|--constraint)$/i;
// Flags whose VALUE is a package name we extract separately (replace/withPackageFlags).
// Skipped WITH their value in the compacted positional view so the value can't leak in
// as a positional and steal the runner's primary slot (`uvx --with evil sometool` must
// keep `sometool` as the first positional). Long forms only; `-p`/glued `=` are handled
// elsewhere (short -p is ambiguous across installers; `--x=v` is one token, auto-dropped).
const VALUE_PKG_FLAG_RE = /^(--package|--spec|--from|--with)$/i;

/** Cut an unquoted trailing `# comment` (one starting a word) before tokenizing, so a
 *  comment's words aren't triaged as packages / mistaken for a registry redirect. A `#`
 *  glued inside a token (`https://x#frag`, `pkg#tag`) is NOT a comment and is kept. */
function stripInlineComment(segment: string): string {
  const m = segment.match(/(?:^|\s)#/);
  return m ? segment.slice(0, m.index) : segment;
}
const DEFAULT_SOURCE_RE =
  /^https?:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org|files\.pythonhosted\.org)(\/|$)/i;

/**
 * Detect an install-SOURCE redirect (alternate registry / index) in a segment's
 * RAW tokens (before `stripCommandPrefix` drops the env assignments). Returns the
 * offending token, or null when none / only the known public default. A value
 * pointing at the canonical registry is benign; anything else → fail-closed.
 */
function sourceRedirect(rawTokens: string[]): string | null {
  for (let i = 0; i < rawTokens.length; i++) {
    const t = rawTokens[i];
    const env = t.match(/^([^\s=]+)=(.*)$/);
    if (env && SOURCE_ENV_RE.test(env[1])) {
      if (env[2] && !DEFAULT_SOURCE_RE.test(env[2])) return t;
      continue;
    }
    const flagEq = t.match(
      /^(--registry|--index-url|--index|--extra-index-url|--default-index|--userconfig|--globalconfig)=(.*)$/i,
    );
    if (flagEq) {
      if (!DEFAULT_SOURCE_RE.test(flagEq[2])) return t;
      continue;
    }
    if (SOURCE_FLAG_RE.test(t) && !DEFAULT_SOURCE_RE.test(rawTokens[i + 1] ?? "")) return t;
  }
  return null;
}

/**
 * A token is a LOCAL target (the user's own code / a file), not a registry
 * package — skip it (there is no reputation to triage). Covers `.`/`..`, relative
 * and absolute paths, home-relative, tarballs/wheels. A token with a URL scheme
 * (`https://…/pkg.tgz`, `git+ssh://…`) is REMOTE, never local — it must NOT be
 * dropped here (it can't be triaged → fail-closed `unverifiable`).
 */
function isLocalTarget(tok: string): boolean {
  if (tok === "." || tok === "..") return true;
  if (/:\/\//.test(tok)) return false; // remote URL — not local, gate it
  if (/^[./~]/.test(tok)) return true; // ./x  ../x  /abs  ~/x
  if (/\.(tgz|tar\.gz|whl)$/i.test(tok)) return true; // a local tarball/wheel path
  return false;
}

/** A clean npm package name (optionally scoped, optionally @version) → bare name. */
function npmName(tok: string): string | null {
  // @scope/name(@version)?  or  name(@version)?  The version excludes `:` so an ALIAS spec
  // (`foo@npm:realpkg`, `foo@git+ssh://…`) fails to validate → routed to `unverifiable`
  // rather than triaging the innocent alias NAME while the aliased target actually installs.
  const m = tok.match(/^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)(@[^/\s:]+)?$/i);
  return m ? m[1] : null;
}

/** A clean PyPI requirement (name plus optional extras/version spec) → bare name. */
function pipName(tok: string): string | null {
  // requests , requests==1.2 , requests[extra] , Flask>=2 — name is the leading run.
  const m = tok.match(/^([a-z0-9][\w.-]*)(\[[\w,.-]*\])?\s*([<>=!~].*)?$/i);
  return m ? m[1] : null;
}

/**
 * The version/dist-tag suffix of an install target, carried onto the triage ref so the gate
 * triages the SPECIFIC version being installed — not `latest`. A clean `latest` can hide a
 * yanked/malicious pinned version (`npm i evil@1.2.3` was triaged as `evil@latest`). Returns
 * "" when no version is pinned. npm form → `@1.2.3`/`@next`; pip form → `==1.2.3`/`>=2`.
 */
function npmVersion(tok: string): string {
  const m = tok.match(/^(?:@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)(@[^/\s:]+)$/i);
  return m ? m[1] : "";
}
function pipVersion(tok: string): string {
  const m = tok.match(/^[a-z0-9][\w.-]*(?:\[[\w,.-]*\])?\s*([<>=!~][^\s]*)$/i);
  return m ? m[1] : "";
}

interface Matcher {
  /** Does this segment's leading tokens start an in-scope install? Returns the index of the first ARG token, or -1. */
  argStart(tokens: string[]): number;
  scheme: "npm" | "pip";
  toName(tok: string): string | null;
  /** A RUNNER (npx/create/exec/uvx…): only the FIRST non-flag arg is the fetched
   *  package; the rest are arguments passed to it. Installers gate every arg. */
  single?: boolean;
  /** Gate ONLY the `--package`/`--with`/… flag packages, never a positional — for
   *  commands whose positional is a local script/command, not a fetched package
   *  (`uv run --with evil script.py`: gate `evil`, not `script.py`). Not an install
   *  unless such a flag is present. */
  pkgFlagOnly?: boolean;
}

/** `npm init foo` / `npm|yarn|pnpm|bun create foo` fetches the `create-foo` initiator
 *  (scoped: `@s/foo` → `@s/create-foo`, bare `@s` → `@s/create`). Map to that package. */
function initiatorName(tok: string): string | null {
  const n = npmName(tok);
  if (!n) return null;
  if (n.startsWith("@")) {
    const [scope, name] = n.slice(1).split("/");
    return name ? `@${scope}/create-${name}` : `@${scope}/create`;
  }
  return `create-${n}`;
}

const PIP_INSTALL_VERB_RE = /^(install|wheel|download)$/;

/** `uv add|pip install|tool install` → first ARG index, else -1. */
function uvInstallerArgStart(b: string | undefined, c: string | undefined): number {
  if (b === "add") return 2;
  if (b === "pip" && c === "install") return 3;
  if (b === "tool" && c === "install") return 3;
  return -1;
}

/** pip/pip3 install|wheel|download, pipx install, uv pip install, uv add, uv tool install,
 *  poetry/pdm add, python -m pip install|wheel|download. Returns the first ARG index or -1.
 *  Extracted from the matcher literal to keep its cyclomatic complexity in bounds.
 *  (wheel/download still fetch from PyPI and run the sdist's setup.py — arbitrary code.) */
function pipInstallerArgStart(t: string[]): number {
  const [a, b, c] = t;
  if (a === "pip" || a === "pip3") return PIP_INSTALL_VERB_RE.test(b ?? "") ? 2 : -1;
  if (a === "pipx") return b === "install" ? 2 : -1;
  if (a === "poetry" || a === "pdm") return b === "add" ? 2 : -1;
  if (a === "uv") return uvInstallerArgStart(b, c);
  if (a === "python" || a === "python3")
    return b === "-m" && c === "pip" && PIP_INSTALL_VERB_RE.test(t[3] ?? "") ? 4 : -1;
  return -1;
}

/** Recognized package-manager invocations, by leading-token shape. */
const MATCHERS: Matcher[] = [
  // npm install|i|add <pkg...>, pnpm add|install, yarn add, bun add  (INSTALLER: all args)
  {
    scheme: "npm",
    toName: npmName,
    argStart: (t) => {
      const bin = t[0];
      // install-test|it also install the named package (then run tests); update|upgrade
      // re-fetch untriaged tarballs at attacker-chosen versions; ci|clean-install do a full
      // lockfile install (running postinstall) — all gated like install. `ci` takes no
      // package operand, so it only matters for the bare-reinstall + registry-redirect check.
      if (
        bin === "npm" &&
        /^(install|i|add|install-test|it|update|upgrade|ci|clean-install)$/.test(t[1] ?? "")
      )
        return 2;
      if (
        (bin === "pnpm" || bin === "yarn" || bin === "bun") &&
        /^(add|install|i|update|upgrade)$/.test(t[1] ?? "")
      )
        return 2;
      // yarn 1 global add / yarn global install
      if (bin === "yarn" && t[1] === "global" && /^(add|install)$/.test(t[2] ?? "")) return 3;
      return -1;
    },
  },
  // package runners that fetch + execute immediately (high risk): npx/bunx <pkg>,
  // npm exec|x <pkg>, pnpm dlx|exec <pkg>, yarn dlx|exec <pkg>, bun x <pkg>.  (RUNNER)
  {
    scheme: "npm",
    toName: npmName,
    single: true,
    argStart: (t) => {
      if (t[0] === "npx" || t[0] === "bunx") return 1;
      if (t[0] === "npm" && (t[1] === "exec" || t[1] === "x")) return 2;
      if ((t[0] === "pnpm" || t[0] === "yarn") && (t[1] === "dlx" || t[1] === "exec")) return 2;
      if (t[0] === "bun" && t[1] === "x") return 2;
      return -1;
    },
  },
  // create/init runners: `npm init|create <name>`, `yarn|pnpm|bun create <name>` — these
  // download and run `create-<name>`, exactly the fetch-and-execute risk npx has. (RUNNER)
  {
    scheme: "npm",
    toName: initiatorName,
    single: true,
    argStart: (t) => {
      if (t[0] === "npm" && /^(init|create)$/.test(t[1] ?? "")) return 2;
      if ((t[0] === "yarn" || t[0] === "pnpm" || t[0] === "bun") && t[1] === "create") return 2;
      return -1;
    },
  },
  // pip/pip3 install, pipx install, uv pip install, uv add, uv tool install, python -m pip
  {
    scheme: "pip",
    toName: pipName,
    argStart: pipInstallerArgStart,
  },
  // python fetch-and-run tools: `uvx <pkg>`, `uv tool run <pkg>`, `pipx run <pkg>`. (RUNNER)
  {
    scheme: "pip",
    toName: pipName,
    single: true,
    argStart: (t) => {
      if (t[0] === "uvx") return 1;
      if (t[0] === "uv" && t[1] === "tool" && t[2] === "run") return 3;
      if (t[0] === "pipx" && t[1] === "run") return 2;
      return -1;
    },
  },
  // `uv run --with <pkg> script`: the positional is a LOCAL script/command, only `--with`
  // fetches a package. Gate only the `--with` package(s); a plain `uv run script` is not an
  // install. (pkgFlagOnly)
  {
    scheme: "pip",
    toName: pipName,
    single: true,
    pkgFlagOnly: true,
    argStart: (t) => (t[0] === "uv" && t[1] === "run" ? 2 : -1),
  },
];

/**
 * Parse a raw Bash command for in-scope package installs. Pure. Conservative:
 * bare `npm install` (no package args, i.e. reinstall declared deps) is NOT an
 * add and is ignored; local paths are ignored; a covered-ecosystem add whose
 * target is neither a clean name nor a local path is `unverifiable` (→ block).
 */
export function parseInstallCommand(command: string): InstallProbe {
  const probe: InstallProbe = { isInstall: false, refs: [], unverifiable: [] };
  if (!command || typeof command !== "string") return probe;

  // Scan the command AND any commands hidden in $(…)/backticks/`-c '…'`, bounded
  // so a wrapper (`sh -c '…'`, `$(…)`) can't smuggle an install past the splitter.
  const seen = new Set<string>();
  const queue: string[] = [command];
  // Dequeue with a head cursor, NOT queue.shift(): shift() is O(N) on a large array, and the
  // `seen` cap doesn't bound the array — a command with many identical nested items (e.g.
  // `$(npm i evil)` repeated) enqueues N duplicates that are shifted-and-skipped, giving O(N²)
  // on the PreToolUse hot path. A cursor makes each dequeue O(1); only-push-unseen keeps the
  // array near-linear in the input.
  const queued = new Set<string>(queue);
  let head = 0;
  while (head < queue.length && seen.size < 64) {
    const cmd = normalizeShellWhitespace(queue[head++]);
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    // Enqueue each distinct nested command once — a command with N identical nested items
    // (`$(npm i evil)` repeated) must not push N duplicates that keep the array growing.
    for (const nested of nestedCommands(cmd)) {
      if (!queued.has(nested)) {
        queued.add(nested);
        queue.push(nested);
      }
    }
    for (const segment of cmd.split(SEGMENT_SPLIT)) scanSegment(segment, probe);
  }

  // De-dup (npm i a a, or a && a).
  probe.refs = [...new Set(probe.refs)];
  probe.unverifiable = [...new Set(probe.unverifiable)];
  return probe;
}

/**
 * Flag-compacted positionals for verb + arg detection. Option flags are dropped so a
 * manager flag BEFORE the subcommand (`npm -g install evil`, `pip -q install evil`,
 * `npm --registry=X install express`) can't shift the verb past the fixed-index matchers
 * — the CRITICAL bypass. Kept: the structural `-m` in `python -m pip`. Skipped together:
 * the VALUE of a source/requirement flag (`--registry URL`, `-r reqs.txt`) so it isn't
 * mistaken for a package. Stops at an inline `#` comment. (Source-redirect and
 * `-p/--package` detection read the FULL tokens/raw, so dropping flags here loses nothing.)
 */
function compactPositionals(tokens: string[]): string[] {
  // `-r`/`-c`/`-e` requirement flags are PIP concepts whose value is a file, not a package.
  // Skipping their value only makes sense for a pip-family command — on an npm/yarn install
  // those aren't valueless flags, so eating the next token would drop a real package
  // (`npm i -e evil` must still gate `evil`). Source/package-value flags exist in both.
  const pipFamily = /^(pip|pip3|pipx|uv|uvx|poetry|pdm|python|python3)$/.test(tokens[0] ?? "");
  const pos: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("#")) break;
    // Structural `-m` in `python -m pip` — also the glued `-mpip` / `-m=pip` forms, which a
    // strict `tok === "-m"` dropped as an ordinary flag (defeating pip detection). Expand
    // to the `-m <module>` positional shape so the pip matcher's fixed indices line up.
    if (pos.length === 1 && /^python3?$/.test(pos[0]) && /^-m(=?.+)?$/.test(tok)) {
      pos.push("-m");
      const glued = tok.match(/^-m=?(.+)$/);
      if (glued) pos.push(glued[1]);
      continue;
    }
    if (
      SOURCE_FLAG_RE.test(tok) ||
      VALUE_PKG_FLAG_RE.test(tok) ||
      (pipFamily && REQUIREMENT_FLAG_RE.test(tok))
    ) {
      i++; // skip the flag AND its value token
      continue;
    }
    if (isFlag(tok)) continue; // drop option flag (can't shift the subcommand)
    pos.push(tok);
  }
  return pos;
}

/** Install/runner verbs — used to fail-close a command run through an unresolvable
 *  binary indirection (`$PM install evil`), where we can't verify what actually runs. */
const INDIRECT_VERB_RE =
  /^(install|install-test|it|i|add|create|init|exec|dlx|x|run|wheel|download|update|upgrade|global)$/;

/**
 * Fail-closed on an install run through an unresolvable indirection: `$PM install evil`,
 * `${X} add evil`, `$(which npm) i evil`, `` `which npm` i evil ``. argv0 isn't a
 * statically-known binary (a bare variable, or a command substitution) and some token is
 * an install/runner verb — we can't verify what actually runs → block. A var-PREFIXED
 * real path like `$HOME/bin/tool` is NOT dynamic (it has a path), so no false positive.
 */
function indirectInstall(tokens: string[], probe: InstallProbe): boolean {
  const dynamicBin =
    /^\$\{?\w+\}?$/.test(tokens[0]) || tokens[0].startsWith("$(") || tokens[0].startsWith("`");
  if (!dynamicBin || !tokens.slice(1).some((t) => INDIRECT_VERB_RE.test(binBase(t)))) return false;
  probe.isInstall = true;
  probe.unverifiable.push(`indirect-bin:${tokens[0]}`);
  return true;
}

/**
 * `npm|pnpm|yarn|bun exec|dlx|x  -c/--call '<str>'` runs `<str>` in a shell, so the
 * positional is NOT a fetched package (`npm exec -c "npm i evil"` would otherwise mis-gate
 * `npm` and miss `evil`). The string itself is recursed by `nestedCommands`; here we just
 * suppress the positional-as-package for the runner.
 */
function hasExecCallFlag(tokens: string[]): boolean {
  const isExecRunner =
    /^(npm|pnpm|yarn|bun)$/.test(tokens[0] ?? "") && /^(exec|dlx|x)$/.test(tokens[1] ?? "");
  if (!isExecRunner) return false;
  // The runner parses `-c`/`--call` only BEFORE the first positional (the command). After
  // the command appears, a `-c` belongs to THAT tool (`npm exec jest -c jest.config.js` —
  // `-c` is jest's; `jest` is a real fetched package that must still be gated), so stop.
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-c" || t === "--call" || /^(-c|--call)=/.test(t)) return true;
    if (t === "--") return false; // everything after `--` is the command + its own args
    if (!t.startsWith("-")) return false; // first positional (the command) reached
    if (/^(-p|--package|--with|--spec|--from)$/.test(t)) i++; // skip a value-consuming flag
  }
  return false;
}

/**
 * The packages a matched invocation actually FETCHES.
 *  - pkgFlagOnly (uv run) / exec -c call: the positional is a LOCAL script or shell string —
 *    only `--with`/`--package` flags fetch; the string is recursed elsewhere.
 *  - other runners: primary = replace-flags (`-p`/`--package`/`--spec`/`--from`) if present
 *    else the first positional, PLUS every `--with` (an extra fetched package).
 *  - installer: every positional is a package.
 */
function resolveTargets(m: Matcher, args: string[], tokens: string[]): string[] {
  if (!m.single) return args;
  const withFlags = withPackageFlags(tokens);
  const replaceFlags = replacePackageFlags(tokens);
  if (m.pkgFlagOnly || hasExecCallFlag(tokens)) return [...replaceFlags, ...withFlags];
  return [...(replaceFlags.length ? replaceFlags : args.slice(0, 1)), ...withFlags];
}

/** Apply one matched matcher to `probe`. Returns true when the segment was consumed. */
function applyMatcher(
  m: Matcher,
  pos: string[],
  tokens: string[],
  raw: string[],
  probe: InstallProbe,
): boolean {
  const start = m.argStart(pos);
  if (start < 0) return false;
  const targets = resolveTargets(m, pos.slice(start), tokens);

  if (targets.length === 0) {
    // `echo evil | xargs npm i` feeds the package on stdin, leaving zero visible args while
    // still installing → fail-closed when this segment is an xargs target.
    if (raw.some((t) => binBase(t) === "xargs")) {
      probe.isInstall = true;
      probe.unverifiable.push("xargs-stdin-install");
      return true;
    }
    // A bare reinstall of declared deps (`npm i`) is benign — UNLESS redirected at an
    // alternate registry/index (`npm i --registry evil`): the tarballs pulled are then
    // attacker-controlled even with no named package → block.
    const bareRedirect = sourceRedirect(raw);
    if (bareRedirect) {
      probe.isInstall = true;
      probe.unverifiable.push(`alt-registry:${bareRedirect}`);
    }
    return true; // otherwise: bare reinstall / runner-or-uv-run with no fetched pkg — not an add
  }
  probe.isInstall = true;
  // A registry/index redirect means the triaged NAME isn't what installs → fail-closed
  // (mark unverifiable) even if every name is reputable.
  const redirect = sourceRedirect(raw);
  if (redirect) probe.unverifiable.push(`alt-registry:${redirect}`);
  for (const arg of targets) {
    if (isLocalTarget(arg)) continue; // user's own code — nothing to triage
    const name = m.toName(arg);
    if (name) {
      // Carry the pinned version/tag onto the ref so triage checks THAT version, not latest.
      const ver = m.scheme === "npm" ? npmVersion(arg) : pipVersion(arg);
      probe.refs.push(`${m.scheme}:${name}${ver}`);
    } else probe.unverifiable.push(arg); // fail-closed: can't reduce to a ref
  }
  return true;
}

/** Match one shell segment against the package-manager matchers, mutating `probe`. */
function scanSegment(segment: string, probe: InstallProbe): void {
  const raw = stripInlineComment(segment)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(dequote)
    .filter(Boolean);
  const tokens = stripCommandPrefix(raw);
  if (tokens.length === 0) return;
  tokens[0] = binBase(tokens[0]); // /usr/bin/npm, \npm, ./bin/pnpm → npm/pnpm

  if (indirectInstall(tokens, probe)) return;

  const pos = compactPositionals(tokens);
  if (pos.length === 0) return;

  for (const m of MATCHERS) {
    if (applyMatcher(m, pos, tokens, raw, probe)) break; // one matcher per segment
  }
}

export interface BashGateVerdict {
  block: boolean;
  reason: string;
  checked: GateVerdict[];
}

/**
 * Decide whether a Bash command should be blocked: triage every in-scope install
 * target via `gateInstall`. Fail-closed — any blocked target, or any
 * unverifiable in-scope arg, blocks the whole command.
 */
export async function decideBashGate(command: string, deps?: GateDeps): Promise<BashGateVerdict> {
  const probe = parseInstallCommand(command);
  if (!probe.isInstall) {
    return { block: false, reason: "no in-scope package install detected", checked: [] };
  }
  if (probe.unverifiable.length > 0) {
    return {
      block: true,
      reason: `cannot reduce to a triage target: ${probe.unverifiable.join(", ")} — run \`kit triage\` manually, or install via \`kit pkg\` (fail-closed)`,
      checked: [],
    };
  }
  const checked: GateVerdict[] = [];
  for (const ref of probe.refs) {
    const v = deps ? await gateInstall(ref, deps) : await gateInstall(ref);
    checked.push(v);
    if (v.decision === "blocked") {
      return { block: true, reason: v.reason, checked };
    }
  }
  return {
    block: false,
    reason:
      checked.length > 0
        ? `triage PASS: ${checked.map((c) => c.tool).join(", ")}`
        : "no registry targets to triage",
    checked,
  };
}

/**
 * Extract the shell command from an agent's PreToolUse-style hook payload,
 * across every wire shape kit's `gate-bash` handler supports:
 *   - Claude Code / Codex / Amazon Q / Gemini / Droid / Augment → `tool_input.command`
 *   - Cursor `beforeShellExecution`            → top-level `command`
 *   - Cline `PreToolUse`                       → `preToolUse.parameters.command`
 *     (verified against @cline/shared `PreToolUseData {toolName, parameters}`)
 *   - Antigravity `run_command` hook          → `toolCall.args.CommandLine`
 *   - Sourcegraph Amp permissions delegate    → `arguments.command`
 * Tolerates array-form (`[bin, ...args]`) by joining on spaces. Returns "" when
 * the tool call carries no shell command (→ the gate allows it). Pure.
 */
export function extractCommandFromHookPayload(payload: unknown): string {
  const p = (payload ?? {}) as {
    tool_input?: { command?: unknown };
    command?: unknown;
    preToolUse?: { parameters?: { command?: unknown } };
    toolCall?: { args?: { CommandLine?: unknown } };
    arguments?: { command?: unknown };
  };
  const raw =
    p.tool_input?.command ??
    p.preToolUse?.parameters?.command ??
    p.toolCall?.args?.CommandLine ??
    p.arguments?.command ??
    p.command;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string").join(" ");
  return "";
}
