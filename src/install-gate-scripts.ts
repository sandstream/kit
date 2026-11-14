/**
 * Commands that switch on install-time code execution for packages nobody triaged.
 *
 * npm 12 skips dependency install scripts unless `allowScripts` names the package, and the
 * install gate holds that grant: `npm approve-scripts <pkg>` is triaged like an install. These
 * forms grant it wholesale and passed `gate-bash` silently (kit-research
 * `supply-chain-2026-fundamentals-vs-kit`):
 *
 *   npm install-scripts approve esbuild --all   npm approves EVERY pending package; `--all`
 *                                               wins over the name (allow-scripts-cmd.js)
 *   npm install --dangerously-allow-all-scripts bypasses the whole allowScripts policy
 *   npm config set ignore-scripts false         turns scripts back on for every later install
 *
 * Read without execution, from shell words. A shell's command string (`sh -c '…'`) is read
 * again, to a bounded depth.
 */
import { shellSegments, shellWords, shellWordValue } from "./install-gate-words.js";

const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
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
const MAX_DEPTH = 3;

const bin = (word: string) =>
  (word.split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd)$/i, "").toLowerCase();

/** `--dangerously-allow-all-scripts`, `--no-ignore-scripts`, `--ignore-scripts=false`. */
function flagBypass(word: string): string | null {
  if (/^--dangerously-allow-all-scripts(=(true|1))?$/i.test(word))
    return "--dangerously-allow-all-scripts";
  if (word === "--no-ignore-scripts" || /^--ignore-scripts=(false|0)$/i.test(word))
    return "ignore-scripts off";
  return null;
}

/** An environment assignment that does the same for every npm run in the command. */
function envBypass(word: string): string | null {
  if (/^npm_config_dangerously_allow_all_scripts=(true|1)$/i.test(word))
    return "npm_config_dangerously_allow_all_scripts";
  if (/^npm_config_ignore_scripts=(false|0)$/i.test(word)) return "npm_config_ignore_scripts=false";
  return null;
}

/** `npm config set <key> <value>` (or `key=value`) that turns scripts on. */
function configBypass(args: string[]): string | null {
  if (args[0] !== "config" || args[1] !== "set") return null;
  const pair = args.slice(2).filter((a) => !a.startsWith("-"));
  const [key, value] = pair[0]?.includes("=") ? pair[0].split("=", 2) : [pair[0], pair[1]];
  const k = (key ?? "").toLowerCase();
  const v = (value ?? "").toLowerCase();
  if (k === "dangerously-allow-all-scripts" && v !== "false" && v !== "0")
    return "npm config set dangerously-allow-all-scripts";
  if (k === "ignore-scripts" && (v === "false" || v === "0"))
    return "npm config set ignore-scripts false";
  return null;
}

/**
 * `npm approve-scripts <pkg> --all` / `npm install-scripts approve <pkg> --all`: the name made
 * the matcher triage just `<pkg>`, while npm's `--all` approves every pending package. A bare
 * `--all` names nothing and is already refused by the matcher (`approve-scripts-all`).
 */
function approveAllBypass(args: string[]): string | null {
  const from =
    args[0] === "approve-scripts"
      ? 1
      : args[0] === "install-scripts" && args[1] === "approve"
        ? 2
        : -1;
  if (from < 0) return null;
  const rest = args.slice(from);
  const all = rest.includes("--all") || rest.includes("-a");
  return all && rest.some((a) => !a.startsWith("-")) ? "approve-scripts <pkg> --all" : null;
}

/** A package-manager invocation's own flags, `config set`, or `approve … --all`. */
function managerBypass(head: string, args: string[]): string | null {
  for (const a of args) {
    const found = flagBypass(a);
    if (found) return found;
  }
  return head === "npm" ? (configBypass(args) ?? approveAllBypass(args)) : null;
}

/** A wrapped command (`sudo -u x npm …`) or a shell's command string (`sh -c '…'`). */
function nestedBypass(head: string, args: string[], depth: number): string | null {
  const k = args.findIndex((a) => MANAGERS.has(bin(a)));
  const tail = k >= 0 ? segmentBypass(args.slice(k).join(" "), depth + 1) : null;
  if (tail || (!SHELLS.has(head) && head !== "eval")) return tail;
  for (const arg of args) {
    const found = /\s/.test(arg) ? commandBypass(arg, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

function segmentBypass(segment: string, depth: number): string | null {
  const words = shellWords(segment).map(shellWordValue);
  const env = words.map(envBypass).find(Boolean);
  if (env) return env;
  const at = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const head = bin(words[at] ?? "");
  const args = words.slice(at + 1);
  if (MANAGERS.has(head)) return managerBypass(head, args);
  return depth >= MAX_DEPTH ? null : nestedBypass(head, args, depth);
}

function commandBypass(command: string, depth: number): string | null {
  for (const segment of shellSegments(command)) {
    const found = segmentBypass(segment, depth);
    if (found) return found;
  }
  return null;
}

/** The install-script grant in `command`, named, or null. Pure. */
export function installScriptBypass(command: string): string | null {
  if (!command || command.length > 100_000) return null;
  return commandBypass(command, 0);
}

/** The refusal: what was caught, and who decides. */
export function installScriptBypassReason(found: string): string {
  return (
    `turns on install scripts for packages nobody triaged (${found}). Approve one package at a ` +
    "time with `npm approve-scripts <pkg>`, which the gate triages; a blanket grant is a " +
    "person's decision (fail-closed)"
  );
}
