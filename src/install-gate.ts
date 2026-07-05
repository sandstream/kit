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
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||&|\n)\s*/;

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
 * Remove quote characters from a token, matching how the shell strips quotes WITHIN a
 * word — `n"p"m` → `npm`, `i'nstall'` → `install`, `'pkg'` → `pkg`. The old version only
 * unwrapped quotes around a WHOLE token, so intra-word quoting (`n"p"m install evil`) hid
 * the binary/subcommand from every matcher — a full gate bypass for any package manager.
 * A backslash-escaped quote (`\"`) is a literal quote in an unquoted word, so keep it.
 */
function dequote(tok: string): string {
  return tok
    .replace(/\\(['"])/g, "\x00$1")
    .replace(/['"]/g, "")
    .replace(/\x00(['"])/g, "$1");
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
  return base && base.length > 0 ? base : noEsc;
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
function nestedCommands(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/\$\(([^()]{1,2000})\)/g)) out.push(m[1]);
  for (const m of command.matchAll(/`([^`]{1,2000})`/g)) out.push(m[1]);
  for (const m of command.matchAll(/-c\s+(['"])([\s\S]{1,2000}?)\1/g)) out.push(m[2]);
  // `eval '…'` / `xargs "…"` — the QUOTED script arg (the unquoted form is handled
  // by SHELL_KEYWORDS stripping). Recurse so a quoted install can't hide behind eval.
  for (const m of command.matchAll(/\b(?:eval|xargs)\s+(['"])([\s\S]{1,2000}?)\1/g)) {
    out.push(m[2]);
  }
  // Process substitution `<(…)` / `>(…)` — the inner command RUNS, so
  // `cat <(npm install evil)` must be gated. The splitter never enters these.
  for (const m of command.matchAll(/[<>]\(([^()]{1,2000})\)/g)) out.push(m[1]);
  // Here-string `<<< "npm i evil"` (quoted or bare word) — the operand is fed to a
  // shell (`bash <<< "npm i evil"`); recurse into it.
  for (const m of command.matchAll(/<<<\s*(['"])([\s\S]{1,2000}?)\1/g)) out.push(m[2]);
  for (const m of command.matchAll(/<<<\s*([^\s'"][^\n]{0,2000})/g)) out.push(m[1]);
  return out;
}

// Env vars / flags that REDIRECT where a package manager fetches from. If any is
// present (pointing anywhere but a known default), the reputable public NAME we
// would triage is NOT what gets installed — so the whole command is unverifiable
// (fail-closed), closing the "triage PASS while pulling attacker code" bypass.
const SOURCE_ENV_RE =
  /^(npm_config_.*registry|npm_config_userconfig|npm_config_globalconfig|.*_registry|yarn_npm_registry_server|pip_index_url|pip_extra_index_url|pip_config_file|uv_index.*|uv_default_index|bun_config_registry)$/i;
const SOURCE_FLAG_RE = /^(--registry|--index-url|--index|--extra-index-url|--default-index|-i)$/i;
// pip flags whose VALUE is a FILE/path, not a registry package — skip the value so
// `pip install -r requirements.txt` isn't mis-triaged as a package `requirements.txt`
// (a false positive that blocks a benign install and pushes users off the gate).
const REQUIREMENT_FLAG_RE = /^(-r|--requirement|-e|--editable|-c|--constraint)$/i;

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
      /^(--registry|--index-url|--index|--extra-index-url|--default-index)=(.*)$/i,
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
  // @scope/name(@version)?  or  name(@version)?
  const m = tok.match(/^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)(@[^/\s]+)?$/i);
  return m ? m[1] : null;
}

/** A clean PyPI requirement (name plus optional extras/version spec) → bare name. */
function pipName(tok: string): string | null {
  // requests , requests==1.2 , requests[extra] , Flask>=2 — name is the leading run.
  const m = tok.match(/^([a-z0-9][\w.-]*)(\[[\w,.-]*\])?\s*([<>=!~].*)?$/i);
  return m ? m[1] : null;
}

interface Matcher {
  /** Does this segment's leading tokens start an in-scope install? Returns the index of the first ARG token, or -1. */
  argStart(tokens: string[]): number;
  scheme: "npm" | "pip";
  toName(tok: string): string | null;
  /** A RUNNER (npx/create/exec/uvx…): only the FIRST non-flag arg is the fetched
   *  package; the rest are arguments passed to it. Installers gate every arg. */
  single?: boolean;
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

/** Recognized package-manager invocations, by leading-token shape. */
const MATCHERS: Matcher[] = [
  // npm install|i|add <pkg...>, pnpm add|install, yarn add, bun add  (INSTALLER: all args)
  {
    scheme: "npm",
    toName: npmName,
    argStart: (t) => {
      const bin = t[0];
      if (bin === "npm" && /^(install|i|add)$/.test(t[1] ?? "")) return 2;
      if (
        (bin === "pnpm" || bin === "yarn" || bin === "bun") &&
        /^(add|install|i)$/.test(t[1] ?? "")
      )
        return 2;
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
    argStart: (t) => {
      if ((t[0] === "pip" || t[0] === "pip3" || t[0] === "pipx") && t[1] === "install") return 2;
      if (t[0] === "uv" && t[1] === "pip" && t[2] === "install") return 3;
      if (t[0] === "uv" && t[1] === "add") return 2;
      if (t[0] === "uv" && t[1] === "tool" && t[2] === "install") return 3;
      if (
        (t[0] === "python" || t[0] === "python3") &&
        t[1] === "-m" &&
        t[2] === "pip" &&
        t[3] === "install"
      )
        return 4;
      return -1;
    },
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
  while (queue.length > 0 && seen.size < 64) {
    const cmd = queue.shift()!;
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    queue.push(...nestedCommands(cmd));
    for (const segment of cmd.split(SEGMENT_SPLIT)) scanSegment(segment, probe);
  }

  // De-dup (npm i a a, or a && a).
  probe.refs = [...new Set(probe.refs)];
  probe.unverifiable = [...new Set(probe.unverifiable)];
  return probe;
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

  // Fail-closed on an install run through an unresolvable indirection: `$PM install evil`,
  // `${X} add evil`. argv0 is a shell variable the static parser can't expand, and the
  // next token is an install/runner verb — we can't verify what actually runs → block.
  if (
    /^\$\{?\w+\}?$/.test(tokens[0]) &&
    /^(install|i|add|create|init|exec|dlx|x|run)$/.test(tokens[1] ?? "")
  ) {
    probe.isInstall = true;
    probe.unverifiable.push(`indirect-bin:${tokens[0]}`);
    return;
  }

  for (const m of MATCHERS) {
    const start = m.argStart(tokens);
    if (start < 0) continue;
    // Build the package args, skipping flags AND the VALUE token of a source flag
    // (`-i URL`, `--registry URL`) or a requirement/editable file flag (`-r reqs.txt`),
    // and stopping at an inline `#` comment token.
    const rest = tokens.slice(start);
    const args: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok.startsWith("#")) break; // inline comment
      if (SOURCE_FLAG_RE.test(tok) || REQUIREMENT_FLAG_RE.test(tok)) {
        i++; // skip the flag AND its value token
        continue;
      }
      if (!isFlag(tok)) args.push(tok);
    }
    if (args.length === 0) {
      // `echo evil | xargs npm i` feeds the package on stdin, leaving zero visible args
      // while still installing. If this segment is an xargs target, fail-closed rather
      // than treating it as a benign bare reinstall.
      if (raw.some((t) => binBase(t) === "xargs")) {
        probe.isInstall = true;
        probe.unverifiable.push("xargs-stdin-install");
      }
      break; // otherwise: bare reinstall of declared deps / runner with no pkg — not an add
    }
    probe.isInstall = true;
    // A registry/index redirect means the triaged NAME isn't what installs →
    // fail-closed (mark unverifiable) even if every name is reputable.
    const redirect = sourceRedirect(raw);
    if (redirect) probe.unverifiable.push(`alt-registry:${redirect}`);
    // A RUNNER (npx/create/exec/uvx…) fetches only its FIRST arg; the rest are that
    // tool's arguments. An INSTALLER treats every arg as a package.
    const targets = m.single ? args.slice(0, 1) : args;
    for (const arg of targets) {
      if (isLocalTarget(arg)) continue; // user's own code — nothing to triage
      const name = m.toName(arg);
      if (name) probe.refs.push(`${m.scheme}:${name}`);
      else probe.unverifiable.push(arg); // fail-closed: can't reduce to a ref
    }
    break; // one matcher per segment
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
