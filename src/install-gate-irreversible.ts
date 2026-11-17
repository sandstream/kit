/**
 * Shell commands that cannot be undone.
 *
 * `gate-bash` passed every one of these: a force push or a push to the default branch, `git reset
 * --hard`, `git clean -fdx`, dropping a stash, discarding the whole working tree, `git branch -D`,
 * a recursive delete of `.git`, `/`, `~`, `.` or `..`, a production deploy and a package publish.
 * The owner chose the strict option: an agent does not run them. The gate names the command and
 * the class, and asks the agent to hand it to the person.
 *
 * Allowed on purpose: `git push origin <feature-branch>` (how agents deliver work), deleting build
 * output (`rm -rf dist node_modules`), `git restore --staged .`, dry runs.
 *
 * Read without execution, like `install-gate-hooks`. Quoted text is data unless a shell runs it
 * (`sh -c '…'`, `$(…)`), which is read again, to a bounded depth.
 */
import {
  bin,
  GIT_VALUE_OPTIONS,
  gitHookBypass,
  hookBypassReason,
  MAX_DEPTH,
  SHELLS,
  WRAPPERS,
} from "./install-gate-hooks.js";
import { installScriptBypass, installScriptBypassReason } from "./install-gate-scripts.js";
import { shellSegments, shellWords, shellWordValue } from "./install-gate-words.js";

/** What was caught: the command class, and the command as the refusal names it. */
export interface Irreversible {
  kind: string;
  named: string;
}

type Check = (args: string[]) => Irreversible | null;

const FORCE_PUSH = "force push";
const DEFAULT_PUSH = "push to the default branch";
const DISCARD = "discards uncommitted work";
const DEPLOY = "production deploy";
const PUBLISH = "package publish";
const DELETE = "recursive delete of what cannot be rebuilt";

const DEFAULT_BRANCHES = new Set(["main", "master"]);
// Pathspecs that name the whole working tree.
const WHOLE_TREE = new Set([".", "./", "*", "./*", ":", ":/", ":/*", ":(top)"]);
// Targets a recursive delete may not touch. `.git` anywhere is matched by its base name.
const PROTECTED = new Set(["/", "/*", "~", "~/*", "$HOME", "${HOME}", ".", "..", "*", ".*"]);
const WINDOWS_REMOVERS = new Set(["remove-item", "ri", "del", "erase", "rd", "rmdir"]);
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "x"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "("]);
const PUSH_VALUE_OPTIONS = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);

const hit = (kind: string, named: string): Irreversible => ({ kind, named });

/** Arguments before `--`. */
function options(args: string[]): string[] {
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
}

/** Non-option arguments; everything after `--` is one. */
function positionals(args: string[]): string[] {
  const end = args.indexOf("--");
  const before = (end < 0 ? args : args.slice(0, end)).filter((a) => !a.startsWith("-"));
  return end < 0 ? before : [...before, ...args.slice(end + 1)];
}

/** A long option or a prefix of it that git would accept (`--forc`), with or without `=value`. */
function isLong(token: string, name: string, min: number): boolean {
  const key = token.split("=")[0]!;
  return key.length >= min && name.startsWith(key);
}

/** A short-option cluster (`-fdx`) holding one of `letters` before any letter that takes a value. */
function clusterHas(token: string, letters: string, valueLetters = ""): boolean {
  if (!/^-[A-Za-z0-9]+$/.test(token)) return false;
  for (const letter of token.slice(1)) {
    if (letters.includes(letter)) return true;
    if (valueLetters.includes(letter)) return false;
  }
  return false;
}

function pushOption(token: string): Irreversible | null {
  if (isLong(token, "--force-with-lease", 9)) return hit(FORCE_PUSH, "git push --force-with-lease");
  if (token === "--force" || isLong(token, "--force", 5) || clusterHas(token, "f", "o"))
    return hit(FORCE_PUSH, "git push --force");
  if (isLong(token, "--mirror", 4)) return hit(FORCE_PUSH, "git push --mirror");
  if (token === "--all" || token === "--branches")
    return hit(DEFAULT_PUSH, `git push ${token} (includes the default branch)`);
  return null;
}

/** `+ref` forces; `src:main`, `HEAD:refs/heads/main` and `main` target the default branch. */
function pushRefspec(spec: string): Irreversible | null {
  if (spec.startsWith("+")) return hit(FORCE_PUSH, `git push +${spec.slice(1)}`);
  const target = spec.slice(spec.lastIndexOf(":") + 1).replace(/^refs\/heads\//, "");
  return DEFAULT_BRANCHES.has(target) ? hit(DEFAULT_PUSH, `git push to ${target}`) : null;
}

function gitPush(args: string[]): Irreversible | null {
  const refs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      refs.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-")) refs.push(a);
    const found = a.startsWith("-") ? pushOption(a) : null;
    if (found) return found;
    if (PUSH_VALUE_OPTIONS.has(a)) i++;
  }
  // The first positional is the remote; the rest are refspecs.
  for (const spec of refs.slice(1)) {
    const found = pushRefspec(spec);
    if (found) return found;
  }
  return null;
}

function gitReset(args: string[]): Irreversible | null {
  return options(args).some((a) => isLong(a, "--hard", 4))
    ? hit(DISCARD, "git reset --hard")
    : null;
}

function gitClean(args: string[]): Irreversible | null {
  const opts = options(args);
  const dryRun = opts.some((a) => isLong(a, "--dry-run", 4) || clusterHas(a, "n", "e"));
  const removes = opts.some((a) => a === "--force" || clusterHas(a, "fxXd", "e"));
  return removes && !dryRun ? hit("deletes untracked files", "git clean -f") : null;
}

function gitStash(args: string[]): Irreversible | null {
  const action = positionals(args)[0] ?? "";
  return action === "drop" || action === "clear"
    ? hit("deletes stashed work", `git stash ${action}`)
    : null;
}

function wholeTree(args: string[]): string | undefined {
  return positionals(args).find((a) => WHOLE_TREE.has(a));
}

function gitCheckout(args: string[]): Irreversible | null {
  if (options(args).some((a) => a === "--force" || clusterHas(a, "f", "bB")))
    return hit(DISCARD, "git checkout --force");
  const path = wholeTree(args);
  return path ? hit(DISCARD, `git checkout -- ${path}`) : null;
}

function gitRestore(args: string[]): Irreversible | null {
  const opts = options(args);
  const staged = opts.some((a) => a === "--staged" || clusterHas(a, "S", "s"));
  const worktree = opts.some((a) => a === "--worktree" || clusterHas(a, "W", "s"));
  if (staged && !worktree) return null; // only unstages: the work stays in the tree
  const path = wholeTree(args);
  return path ? hit(DISCARD, `git restore ${path}`) : null;
}

function gitSwitch(args: string[]): Irreversible | null {
  const discards = options(args).some(
    (a) => a === "--discard-changes" || a === "--force" || clusterHas(a, "f", "cC"),
  );
  return discards ? hit(DISCARD, "git switch --discard-changes") : null;
}

function gitBranch(args: string[]): Irreversible | null {
  const opts = options(args);
  if (opts.some((a) => clusterHas(a, "D")))
    return hit("deletes an unmerged branch", "git branch -D");
  const deletes = opts.some((a) => a === "--delete" || clusterHas(a, "d"));
  const force = opts.some((a) => a === "--force" || clusterHas(a, "f"));
  return deletes && force ? hit("deletes an unmerged branch", "git branch --delete --force") : null;
}

const GIT_CHECKS = new Map<string, Check>([
  ["push", gitPush],
  ["reset", gitReset],
  ["clean", gitClean],
  ["stash", gitStash],
  ["checkout", gitCheckout],
  ["restore", gitRestore],
  ["switch", gitSwitch],
  ["branch", gitBranch],
]);

function gitIrreversible(args: string[]): Irreversible | null {
  let i = 0;
  for (; i < args.length && args[i]!.startsWith("-"); i++) if (GIT_VALUE_OPTIONS.has(args[i]!)) i++;
  const check = GIT_CHECKS.get(args[i] ?? "");
  return check ? check(args.slice(i + 1)) : null;
}

/** `/`, `~`, `.`, `..`, or anything named `.git`. Trailing separators and `./` do not change it. */
function protectedTarget(target: string): boolean {
  let path = target.replace(/[\\/]+$/, "") || (target ? "/" : "");
  while (/^\.[\\/]./.test(path)) path = path.slice(2);
  if (PROTECTED.has(path) || /^[A-Za-z]:$/.test(path)) return true;
  return (path.split(/[\\/]/).pop() ?? "").toLowerCase() === ".git";
}

function removal(named: string, recursive: boolean, targets: string[]): Irreversible | null {
  const target = recursive ? targets.find(protectedTarget) : undefined;
  return target ? hit(DELETE, `${named} ${target}`) : null;
}

function rmIrreversible(args: string[]): Irreversible | null {
  const recursive = options(args).some((a) => a === "--recursive" || clusterHas(a, "rR"));
  return removal("rm -r", recursive, positionals(args));
}

/** PowerShell `Remove-Item -Recurse` (any prefix) and cmd `rmdir /s`. */
function windowsRemove(args: string[]): Irreversible | null {
  const lower = args.map((a) => a.toLowerCase());
  const recursive = lower.some((a) => a === "/s" || (a.length >= 2 && "-recurse".startsWith(a)));
  const targets = args.filter((a) => !a.startsWith("-") && !/^\/[A-Za-z]$/.test(a));
  return removal("Remove-Item -Recurse", recursive, targets);
}

const first = (args: string[]) => positionals(args)[0] ?? "";
const dryRun = (args: string[]) => args.includes("--dry-run");

function publishes(tool: string, args: string[]): Irreversible | null {
  const [sub, next] = positionals(args);
  const publish = sub === "publish" || (tool === "yarn" && sub === "npm" && next === "publish");
  return publish && !dryRun(args) ? hit(PUBLISH, `${tool} publish`) : null;
}

const DEPLOYS = new Map<string, Check>([
  [
    "vercel",
    (a) =>
      a.some((x) => /^--prod(uction)?(=true)?$/.test(x)) ? hit(DEPLOY, "vercel --prod") : null,
  ],
  ["fly", (a) => (first(a) === "deploy" ? hit(DEPLOY, "fly deploy") : null)],
  ["flyctl", (a) => (first(a) === "deploy" ? hit(DEPLOY, "flyctl deploy") : null)],
  [
    "netlify",
    (a) =>
      first(a) === "deploy" && a.some((x) => /^(--prod(=true)?|-p|--prod-if-unlocked)$/.test(x))
        ? hit(DEPLOY, "netlify deploy --prod")
        : null,
  ],
  ["wrangler", wranglerDeploy],
  ["railway", (a) => (first(a) === "up" ? hit(DEPLOY, "railway up") : null)],
  ["firebase", (a) => (first(a) === "deploy" ? hit(DEPLOY, "firebase deploy") : null)],
]);

function wranglerDeploy(args: string[]): Irreversible | null {
  const words = positionals(args);
  const sub = words[0] === "pages" ? words[1] : words[0];
  const deploys = sub === "deploy" || sub === "publish";
  return deploys && !dryRun(args)
    ? hit(DEPLOY, `wrangler ${words.slice(0, words[0] === "pages" ? 2 : 1).join(" ")}`)
    : null;
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** `npm publish`, or `pnpm dlx vercel --prod`: the runner's tail is a command. */
function packageManager(tool: string, args: string[], depth: number): Irreversible | null {
  const sub = first(args);
  if (!RUNNER_SUBCOMMANDS.has(sub)) return publishes(tool, args);
  return depth >= MAX_DEPTH ? null : wrapped(args.slice(args.indexOf(sub) + 1), depth);
}

/** The command name, without a path, `.exe` or a runner's `@version`. */
function headOf(word: string): string {
  return bin(word).replace(/^([^@]+)@.*$/, "$1");
}

function knownHead(head: string): boolean {
  return (
    head === "git" ||
    head === "rm" ||
    WINDOWS_REMOVERS.has(head) ||
    DEPLOYS.has(head) ||
    PACKAGE_MANAGERS.has(head) ||
    SHELLS.has(head)
  );
}

/** `sudo -u x git …`, `npx -y vercel --prod`, `cmd /c rmdir /s .git`: read from the command on. */
function wrapped(args: string[], depth: number): Irreversible | null {
  const k = args.findIndex((a) => knownHead(headOf(a)));
  return k < 0 ? null : wordsFound(args.slice(k), depth + 1);
}

/** A shell's command string is run: read each multi-word argument as a command. */
function shellString(args: string[], depth: number): Irreversible | null {
  for (const arg of args) {
    const found = /\s/.test(arg) ? commandFound(arg, depth + 1) : null;
    if (found) return found;
  }
  return wrapped(args, depth);
}

function wordsFound(words: string[], depth: number): Irreversible | null {
  const head = headOf(words[0] ?? "");
  const args = words.slice(1);
  if (head === "git") return gitIrreversible(args);
  if (head === "rm") return rmIrreversible(args);
  if (WINDOWS_REMOVERS.has(head)) return windowsRemove(args);
  const deploy = DEPLOYS.get(head);
  if (deploy) return deploy(args);
  if (PACKAGE_MANAGERS.has(head)) return packageManager(head, args, depth);
  if (depth >= MAX_DEPTH) return null;
  if (WRAPPERS.has(head) || RUNNERS.has(head)) return wrapped(args, depth);
  return SHELLS.has(head) || head === "eval" ? shellString(args, depth) : null;
}

/** Grouping characters glued to a word (`(cd x`, `-f)`) are syntax, not part of it. */
function segmentWords(segment: string): string[] {
  const words = shellWords(segment)
    .map((w) => shellWordValue(w).replace(/^[({]+|[)}]+$/g, ""))
    .filter(Boolean);
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]!) || KEYWORDS.has(words[i]!))) i++;
  return words.slice(i);
}

function commandFound(command: string, depth: number): Irreversible | null {
  for (const segment of shellSegments(command)) {
    const found = wordsFound(segmentWords(segment), depth);
    if (found) return found;
  }
  if (depth >= MAX_DEPTH) return null;
  // `$(…)` and backticks run, even inside double quotes.
  for (const m of command.matchAll(/\$\(([^()]{1,2000})\)|`([^`]{1,2000})`/g)) {
    const found = commandFound(m[1] ?? m[2]!, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The command in `command` that cannot be undone, with its class, or null. Pure. */
export function irreversibleCommand(command: string): Irreversible | null {
  if (!command || command.length > 100_000) return null;
  return commandFound(command, 0);
}

/** The refusal: what was caught, its class, and who runs it. */
export function irreversibleReason(found: Irreversible): string {
  return (
    `cannot be undone: ${found.kind} (${found.named}). Ask the person to run it themselves; ` +
    "an agent does not run a command that cannot be undone (fail-closed)"
  );
}

/**
 * The refusals `decideBashGate` makes before any registry request: hook bypasses, then commands
 * that cannot be undone. `heredocs` is the command with data-only here-document bodies removed,
 * and the substitutions they still run.
 */
export function policyRefusal(
  command: string,
  heredocs: { command: string; expansions: string[] },
): string | null {
  const grant = installScriptBypass(command);
  if (grant) return installScriptBypassReason(grant);
  const bypass = gitHookBypass(command);
  if (bypass) return hookBypassReason(bypass);
  const found = [heredocs.command, ...heredocs.expansions].map(irreversibleCommand).find(Boolean);
  return found ? irreversibleReason(found) : null;
}
