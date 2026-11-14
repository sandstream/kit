/**
 * Commands that skip the repository's git hooks.
 *
 * kit's commit checks (secret scan, build) run in the git hooks. An agent that commits with
 * `--no-verify`, overrides `core.hooksPath`, sets `HUSKY=0` or deletes a hook file runs none of
 * them, and `gate-bash` passed all of these silently (kit-research
 * `checks-in-harness-hooks-vs-kit`). Skipping the hooks is a person's decision, so the gate names
 * the command and refuses it.
 *
 * Read without execution. Quoted text is data unless a shell runs it (`sh -c '…'`), which is
 * read again, to a bounded depth.
 */
import { shellSegments, shellWords, shellWordValue } from "./install-gate-words.js";

const MAX_DEPTH = 3;
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
]);
// Subcommands that run a hook and take `--no-verify`.
const VERIFY_SUBCOMMANDS = new Set([
  "commit",
  "push",
  "merge",
  "rebase",
  "am",
  "cherry-pick",
  "revert",
  "pull",
]);
// git's global options that take a separate value.
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);
// commit's short options that take a value, so a later letter in the cluster is that value.
const COMMIT_VALUE_SHORTS = new Set(["m", "F", "c", "C", "t", "S", "u"]);
const HOOK_FILES = /(^|[\\/])(\.git[\\/]hooks|\.husky)([\\/]|$)/;
const FILE_EDITORS = new Set(["rm", "unlink", "mv", "chmod", "truncate", "shred"]);

function bin(word: string): string {
  return (word.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
}

const isHooksPathKey = (key: string) => key.toLowerCase() === "core.hookspath";

/** `--no-verify`, or a prefix git would expand to it. */
function isNoVerify(token: string): boolean {
  return token.length >= 6 && "--no-verify".startsWith(token);
}

/** `-n` in a commit short-option cluster, before any letter that takes a value. */
function commitShortNoVerify(token: string): boolean {
  if (!/^-[A-Za-z]+$/.test(token)) return false;
  for (const letter of token.slice(1)) {
    if (letter === "n") return true;
    if (COMMIT_VALUE_SHORTS.has(letter)) return false;
  }
  return false;
}

/** A `core.hooksPath` override among one global option and its value, or null. */
function globalOptionBypass(option: string, value: string): string | null {
  if (option === "-c" && isHooksPathKey(value.split("=")[0]!)) return "git -c core.hooksPath";
  if (/^-c./.test(option) && isHooksPathKey(option.slice(2).split("=")[0]!))
    return "git -c core.hooksPath";
  if (option.startsWith("--config-env") && /core\.hookspath/i.test(`${option} ${value}`))
    return "git --config-env core.hooksPath";
  return null;
}

/** `--no-verify` (or commit's `-n`) among a hook-running subcommand's arguments, or null. */
function noVerifyBypass(sub: string, rest: string[]): string | null {
  for (let j = 0; j < rest.length && rest[j] !== "--"; j++) {
    const a = rest[j]!;
    if (isNoVerify(a)) return `git ${sub} --no-verify`;
    if (sub !== "commit") continue;
    if (commitShortNoVerify(a)) return "git commit -n (--no-verify)";
    if (/^-[mFcCt]$/.test(a)) j++; // skip the option's value
  }
  return null;
}

function gitBypass(args: string[]): string | null {
  let i = 0;
  for (; i < args.length && args[i]!.startsWith("-"); i++) {
    const found = globalOptionBypass(args[i]!, args[i + 1] ?? "");
    if (found) return found;
    if (GIT_VALUE_OPTIONS.has(args[i]!)) i++;
  }
  const sub = args[i] ?? "";
  const rest = args.slice(i + 1);
  if (sub === "config") {
    const reads = rest.some((a) => /^(--get|--get-all|--get-regexp|-l|--list|get|list)$/.test(a));
    return !reads && rest.some(isHooksPathKey) ? "git config core.hooksPath" : null;
  }
  return VERIFY_SUBCOMMANDS.has(sub) ? noVerifyBypass(sub, rest) : null;
}

const WRAPPERS = new Set([
  "env",
  "sudo",
  "doas",
  "nice",
  "nohup",
  "timeout",
  "time",
  "command",
  "exec",
  "xargs",
]);
const skipsHuskyHooks = (word: string) =>
  /^HUSKY=(0|false)$/i.test(word) || /^HUSKY_SKIP_HOOKS=(1|true)$/i.test(word);

/** `env HUSKY=0 git …`, `sudo -u x git …`: read from the wrapped command on. */
function wrappedBypass(args: string[], depth: number): string | null {
  const husky = args.find(skipsHuskyHooks);
  if (husky) return husky;
  const k = args.findIndex(
    (a) => bin(a) === "git" || SHELLS.has(bin(a)) || FILE_EDITORS.has(bin(a)),
  );
  return k < 0 ? null : segmentBypass(args.slice(k).map(quoteWord).join(" "), depth + 1);
}

/** A shell's command string is run: read each multi-word argument as a command. */
function shellStringBypass(args: string[], depth: number): string | null {
  for (const arg of args) {
    const found = /\s/.test(arg) ? commandBypass(arg, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

function segmentBypass(segment: string, depth: number): string | null {
  const words = shellWords(segment).map(shellWordValue);
  let i = 0;
  // Leading assignments (`HUSKY=0 git commit`) apply to the command they precede.
  for (; i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!); i++) {
    if (skipsHuskyHooks(words[i]!)) return words[i]!;
  }
  const head = bin(words[i] ?? "");
  const args = words.slice(i + 1);
  if (head === "export") return args.find(skipsHuskyHooks) ?? null;
  if (head === "git") return gitBypass(args);
  if (FILE_EDITORS.has(head))
    return args.some((a) => HOOK_FILES.test(a)) ? `${head} on a git hook` : null;
  if (depth >= MAX_DEPTH) return null;
  if (WRAPPERS.has(head)) return wrappedBypass(args, depth);
  return SHELLS.has(head) || head === "eval" ? shellStringBypass(args, depth) : null;
}

/** Re-quote a word so joining and re-splitting keeps it one word. */
function quoteWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

function commandBypass(command: string, depth: number): string | null {
  for (const segment of shellSegments(command)) {
    const found = segmentBypass(segment, depth);
    if (found) return found;
  }
  return null;
}

/** The git-hook bypass in `command`, named, or null. Pure. */
export function gitHookBypass(command: string): string | null {
  if (!command || command.length > 100_000) return null;
  return commandBypass(command, 0);
}

/** The refusal for a hook bypass: what was caught, and who decides. */
export function hookBypassReason(found: string): string {
  return (
    `skips the repository's git hooks (${found}). kit's commit checks run in those hooks; ` +
    "a person decides to skip them, not the agent (fail-closed)"
  );
}
