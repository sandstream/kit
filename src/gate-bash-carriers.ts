/**
 * The carriers `gate-bash` reads through to reach the command a shell would really run.
 *
 * `sh -c '…'`, `env X=1 …`, `sudo -u x …`, `xargs …`, `npx -y <pkg> …`, `npm exec` / `pnpm dlx`,
 * `$(…)`, backticks, `cmd /c`, PowerShell `-Command` / `-EncodedCommand` and an agent launcher
 * (`herdr pane new --kind claude -- <argv>`) all run another command. A classifier names the commands it cares about (`isTarget`) and reads one of them
 * (`read`); this walk finds them behind any carrier, to a bounded depth.
 *
 * Shared by the nested-agent classifier (`nested-agent-bypass`) and the GitHub token actions
 * (`gh-token-actions`), so both read the same carriers. Read without execution: quoted text is data
 * unless a shell runs it.
 */
import { bin, MAX_DEPTH, SHELLS, WRAPPERS } from "./install-gate-hooks.js";
import { windowsShellBodies } from "./install-gate-shells.js";
import { shellSegments, shellWords, shellWordValue } from "./install-gate-words.js";

/** What a classifier looks for. */
export interface CommandReader<T> {
  /** A command word this classifier reads: `claude`, `/usr/bin/gh`, `@openai/codex@1.0`. */
  isTarget(word: string): boolean;
  /** Read one target command: its word, arguments and the assignments before it. */
  read(head: string, args: string[], env: string[]): T | null;
}

const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUNNER_SUBCOMMANDS = new Set(["exec", "dlx", "x"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "("]);
/** Terminal and agent managers that start a command given after `--` (kit-research copybook-vs-kit). */
const LAUNCHERS = new Set(["herdr"]);

/**
 * The command a launcher starts: `herdr … --kind <agent> -- <argv>` starts `<agent> <argv>`, and
 * `herdr … -- <cmd …>` starts `<cmd …>`. Without `--` it starts nothing (`herdr pane list`).
 */
function launchedCommand(args: readonly string[]): string[] | null {
  const end = args.indexOf("--");
  if (end < 0) return null;
  const at = args.slice(0, end).findIndex((a) => a === "--kind" || a.startsWith("--kind="));
  const kind = at < 0 ? "" : args[at]!.startsWith("--kind=") ? args[at]!.slice(7) : args[at + 1];
  return kind ? [kind, ...args.slice(end + 1)] : args.slice(end + 1);
}

class Walk<T> {
  constructor(private readonly reader: CommandReader<T>) {}

  private knownHead(word: string): boolean {
    const head = bin(word);
    return (
      this.reader.isTarget(word) ||
      SHELLS.has(head) ||
      WRAPPERS.has(head) ||
      RUNNERS.has(head) ||
      PACKAGE_MANAGERS.has(head) ||
      LAUNCHERS.has(head)
    );
  }

  /** `env X=1 gh …`, `npx -y @openai/codex …`, `sudo -u x gh …`: read from the command on. */
  private wrapped(args: string[], depth: number): T | null {
    const k = args.findIndex((a) => this.knownHead(a));
    if (k < 0) return null;
    const env = args.slice(0, k).filter((a) => ASSIGNMENT.test(a));
    return this.words([...env, ...args.slice(k)], depth + 1);
  }

  /** A shell's command string is run: read each multi-word argument as a command. */
  private shellString(args: string[], depth: number): T | null {
    for (const arg of args) {
      const found = /\s/.test(arg) ? this.command(arg, depth + 1) : null;
      if (found) return found;
    }
    return this.wrapped(args, depth);
  }

  /** A wrapper, runner, package-manager runner or shell around another command. */
  private viaCarrier(head: string, args: string[], depth: number): T | null {
    if (depth >= MAX_DEPTH) return null;
    if (WRAPPERS.has(head) || RUNNERS.has(head)) return this.wrapped(args, depth);
    if (LAUNCHERS.has(head)) {
      const launched = launchedCommand(args);
      return launched ? this.words(launched, depth + 1) : null;
    }
    if (PACKAGE_MANAGERS.has(head) && RUNNER_SUBCOMMANDS.has(args[0] ?? ""))
      return this.wrapped(args.slice(1), depth);
    return SHELLS.has(head) || head === "eval" ? this.shellString(args, depth) : null;
  }

  words(words: readonly string[], depth: number): T | null {
    let i = 0;
    const env: string[] = [];
    for (; i < words.length && (ASSIGNMENT.test(words[i]!) || KEYWORDS.has(words[i]!)); i++)
      if (ASSIGNMENT.test(words[i]!)) env.push(words[i]!);
    const head = words[i] ?? "";
    const args = words.slice(i + 1);
    if (this.reader.isTarget(head)) return this.reader.read(head, args, env);
    return this.viaCarrier(bin(head), args, depth);
  }

  command(command: string, depth: number): T | null {
    for (const segment of shellSegments(command)) {
      const found = this.words(segmentWords(segment), depth);
      if (found) return found;
    }
    if (depth >= MAX_DEPTH) return null;
    for (const inner of innerCommands(command)) {
      const found = this.command(inner, depth + 1);
      if (found) return found;
    }
    return null;
  }
}

/** Grouping characters glued to a word (`(claude`, `-y)`) are syntax, not part of it. */
function segmentWords(segment: string): string[] {
  return shellWords(segment)
    .map((w) => shellWordValue(w).replace(/^[({]+|[)}]+$/g, ""))
    .filter(Boolean);
}

/** Text a shell runs inside this command: `$(…)`, backticks, `cmd /c`, `powershell -c|-e`. */
function innerCommands(command: string): string[] {
  const out = [...command.matchAll(/\$\(([^()]{1,2000})\)|`([^`]{1,2000})`/g)].map(
    (m) => m[1] ?? m[2]!,
  );
  return [...out, ...windowsShellBodies(command)];
}

/**
 * The first target `reader` finds in `command`, read through every carrier, or null. `command` is
 * a shell command string, or one argv. Pure.
 */
export function readThroughCarriers<T>(
  command: string | readonly string[],
  reader: CommandReader<T>,
): T | null {
  const walk = new Walk(reader);
  if (typeof command !== "string") return walk.words(command, 0);
  if (!command || command.length > 100_000) return null;
  return walk.command(command, 0);
}
