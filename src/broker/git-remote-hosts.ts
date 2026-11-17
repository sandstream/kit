/**
 * kit exec-broker — git network targets for the egress-gate.
 *
 * `git push origin main` names a REMOTE, not a host, so the URL pass in extract.ts never sees
 * it. Under a verified scope the egress-gate resolves those names to the URL git will actually
 * use (`git remote get-url`, which applies `insteadOf` rewrites) and checks that URL's host.
 *
 *   - `git push|fetch|pull|ls-remote|remote update <name>` → the remote's URL (push → push URL).
 *   - an explicit URL argument (`git clone <url>`, `git fetch <url>`) → its host, including the
 *     ssh forms `git@host:org/repo.git` and `ssh://git@host/org/repo.git`.
 *   - no remote argument → the current branch's upstream remote, else `origin`.
 *   - `--all` (fetch / remote update with no names) → every configured remote.
 *
 * A name git cannot resolve is reported in `unresolved`; the gate denies it as an unknown host.
 * Local paths and `file://` URLs carry no host and are skipped. The runner is injectable so the
 * parsing and resolution are tested without a real repository.
 */
import { resolve } from "node:path";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import { shellSplit } from "../utils/shellSplit.js";

/** Runs `git <args>` in `cwd` (no shell); stdout on success, null on any failure. */
export type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

export interface GitTargets {
  /** Lowercased hostnames the git commands would contact. */
  hosts: string[];
  /** Remote names (or remote-shaped arguments) git could not resolve to a URL. */
  unresolved: string[];
}

/** One git network invocation found in a command. */
export interface GitInvocation {
  sub: "push" | "fetch" | "pull" | "ls-remote" | "clone" | "remote-update";
  cwd: string;
  /** Positional arguments after the subcommand (remote or URL first). */
  positionals: string[];
  all: boolean;
}

const GIT_TIMEOUT_MS = 3000;

const defaultRunner: GitRunner = async (args, cwd) => {
  const r = await execFileNoThrow("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  return r.ok ? r.stdout.trim() : null;
};

/** git global options that consume the next token. */
const GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** Subcommand options that consume the next token, so it is never read as a remote. */
const SUB_VALUE_OPTS = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
  "--upload-pack",
  "--depth",
  "--deepen",
  "--shallow-since",
  "--shallow-exclude",
  "-j",
  "--jobs",
  "-b",
  "--branch",
  "--origin",
  "--reference",
  "--reference-if-able",
  "--separate-git-dir",
  "--template",
  "--config",
  "--filter",
  "--negotiation-tip",
  "--server-option",
  "--refmap",
  "--recurse-submodules-default",
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
]);

/** `-u` is `--upload-pack` and `-c` is `--config` for clone/ls-remote only (`push -u` sets upstream). */
const CLONE_VALUE_OPTS = new Set(["-u", "-c"]);

function takesValue(sub: string, tok: string): boolean {
  return (
    SUB_VALUE_OPTS.has(tok) ||
    ((sub === "clone" || sub === "ls-remote") && CLONE_VALUE_OPTS.has(tok))
  );
}

const SUBCOMMANDS = new Set(["push", "fetch", "pull", "ls-remote", "clone"]);

/** Strip surrounding quotes left by a naive split and return argv for one shell segment. */
function tokensOf(segment: string): string[] {
  try {
    return shellSplit(segment);
  } catch {
    return segment.trim().split(/\s+/).filter(Boolean);
  }
}

/** Skip git's global options; returns the subcommand index and the effective cwd. */
function skipGlobals(tokens: string[], start: number, cwd: string): { i: number; cwd: string } {
  let i = start;
  let dir = cwd;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const tok = tokens[i];
    if (tok === "-C" && i + 1 < tokens.length) dir = resolve(dir, tokens[i + 1]);
    i += GLOBAL_VALUE_OPTS.has(tok) ? 2 : 1;
  }
  return { i, cwd: dir };
}

/** Positionals after a subcommand, skipping options and their values. */
function collectArgs(sub: string, tokens: string[]): { positionals: string[]; all: boolean } {
  const positionals: string[] = [];
  let all = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (tok === "--all") all = true;
    if (!tok.startsWith("-")) positionals.push(tok);
    else if (takesValue(sub, tok)) i++;
  }
  return { positionals, all };
}

/** Parse one shell segment into a git network invocation, or null. */
function parseSegment(segment: string, cwd: string): GitInvocation | null {
  const tokens = tokensOf(segment);
  const gi = tokens.findIndex((t) => /(^|[\\/])git(\.exe)?$/i.test(t));
  if (gi < 0) return null;
  const g = skipGlobals(tokens, gi + 1, cwd);
  const word = tokens[g.i];
  let rest = tokens.slice(g.i + 1);
  let sub: GitInvocation["sub"];
  if (SUBCOMMANDS.has(word)) sub = word as GitInvocation["sub"];
  else if (word === "remote" && rest[0] === "update") {
    sub = "remote-update";
    rest = rest.slice(1);
  } else return null;
  const { positionals, all } = collectArgs(sub, rest);
  return {
    sub,
    cwd: g.cwd,
    positionals,
    all: all || (sub === "remote-update" && !positionals.length),
  };
}

/** Every git network invocation in a shell command (split on shell separators). */
export function findGitNetworkCommands(command: string, cwd: string): GitInvocation[] {
  const out: GitInvocation[] = [];
  for (const segment of command.split(/&&|\|\||[;\n|&]/)) {
    const inv = parseSegment(segment, cwd);
    if (inv) out.push(inv);
  }
  return out;
}

/** True when the argument is a URL or scp-like address rather than a remote name. */
export function isGitUrl(arg: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return true;
  // scp-like `[user@]host:path`: a colon before any slash, and not a Windows drive (`C:\`).
  const colon = arg.indexOf(":");
  if (colon <= 1) return false;
  const slash = arg.search(/[\\/]/);
  return slash === -1 || colon < slash;
}

/** True when the argument is a local path (no network). */
function isLocalPath(arg: string): boolean {
  return /^(\.{1,2}([\\/]|$)|[\\/~]|[a-z]:[\\/])/i.test(arg) || /^file:/i.test(arg);
}

/** The host of a git URL (`https://`, `ssh://`, `git://`, scp-like); null for local or garbage. */
export function gitUrlHost(url: string): string | null {
  if (isLocalPath(url)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
      return h ? h.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  const m = /^(?:[^@/\\]+@)?(\[[^\]]+\]|[^:/\\]+):/.exec(url);
  return m ? m[1].replace(/^\[|\]$/g, "").toLowerCase() : null;
}

/** The remote the current branch tracks, else `origin`. */
async function defaultRemote(cwd: string, run: GitRunner): Promise<string> {
  const branch = await run(["symbolic-ref", "-q", "--short", "HEAD"], cwd);
  if (!branch) return "origin";
  const remote = await run(["config", "--get", `branch.${branch}.remote`], cwd);
  return remote || "origin";
}

/** The remote names / URLs one invocation targets. */
async function targetsOf(inv: GitInvocation, run: GitRunner): Promise<string[]> {
  if (inv.all) {
    const list = await run(["remote"], inv.cwd);
    return list ? list.split(/\r?\n/).filter(Boolean) : ["origin"];
  }
  if (inv.sub === "remote-update") return inv.positionals;
  if (inv.positionals.length > 0) return [inv.positionals[0]];
  return inv.sub === "clone" ? [] : [await defaultRemote(inv.cwd, run)];
}

/** Resolve one target to a host: "" for a host-less target, null when unresolvable. */
async function resolveTarget(
  target: string,
  inv: GitInvocation,
  run: GitRunner,
): Promise<string | null> {
  if (target === "." || isLocalPath(target)) return "";
  if (isGitUrl(target)) return gitUrlHost(target) ?? "";
  if (inv.sub === "clone") return ""; // clone's first positional that is not a URL is a local path
  const args = ["remote", "get-url", ...(inv.sub === "push" ? ["--push"] : []), target];
  const url = await run(args, inv.cwd);
  if (!url) return null;
  return gitUrlHost(url) ?? "";
}

/**
 * The hosts the git network commands in `command` would contact, resolving remote names in the
 * repository at `cwd` (or the `-C` directory). Names git cannot resolve land in `unresolved`.
 */
export async function resolveGitTargets(
  command: string,
  cwd: string,
  run: GitRunner = defaultRunner,
): Promise<GitTargets> {
  const hosts = new Set<string>();
  const unresolved = new Set<string>();
  for (const inv of findGitNetworkCommands(command, cwd)) {
    for (const target of await targetsOf(inv, run)) {
      const host = await resolveTarget(target, inv, run);
      if (host === null) unresolved.add(target);
      else if (host) hosts.add(host);
    }
  }
  return { hosts: [...hosts].sort(), unresolved: [...unresolved].sort() };
}
