/**
 * Repository references that installers fetch: the shared reduction to `owner/repo`, and the
 * Claude Code plugin commands that add third-party code to the agent itself.
 */
import type { InstallProbe } from "./install-gate.js";
import { unwrapCommandWrappers } from "./install-gate-wrappers.js";

export interface NpmRunnerInvocation {
  packages: string[];
  argv: string[];
  shadowable: boolean;
  optionTokens: string[];
  unverifiable: string[];
}

const NPM_RUNNER_VALUE_FLAGS = new Set([
  "--registry",
  "--userconfig",
  "--globalconfig",
  "--cache",
  "--prefix",
  "-C",
  "--loglevel",
  "--location",
  "-L",
  "--workspace",
  "-w",
  "--script-shell",
  "--shell",
]);

const NPM_RUNNER_SWITCHES = new Set([
  "-y",
  "--yes",
  "--no",
  "--no-install",
  "-q",
  "--quiet",
  "-s",
  "--silent",
  "-g",
  "--global",
  "--parseable",
  "--json",
  "--offline",
  "--prefer-offline",
  "--prefer-online",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--workspaces",
  "--include-workspace-root",
  "-v",
  "--version",
  "-h",
  "--help",
]);

type RunnerOptionKind = "package" | "call" | "child" | "value" | "switch" | "unknown";

function runnerOptionKind(manager: string, flag: string, afterCommand: boolean): RunnerOptionKind {
  if (flag === "--package" || (manager === "npx" && flag === "-p")) return "package";
  if (flag === "-c" || flag === "--call") return afterCommand ? "child" : "call";
  if (NPM_RUNNER_VALUE_FLAGS.has(flag)) return "value";
  if ((manager === "npm" && flag === "-p") || NPM_RUNNER_SWITCHES.has(flag)) return "switch";
  return "unknown";
}

interface RunnerWords {
  packages: string[];
  argv: string[];
  optionTokens: string[];
  unverifiable: string[];
  call: boolean;
}

/** Consume one manager option using that manager's arity, before the command boundary. */
function consumeRunnerOption(
  manager: string,
  tokens: readonly string[],
  i: number,
  words: RunnerWords,
): number {
  const tok = tokens[i];
  const equals = tok.indexOf("=");
  const flag = equals < 0 ? tok : tok.slice(0, equals);
  const kind = runnerOptionKind(manager, flag, words.argv.length > 0);
  words.optionTokens.push(tok);
  if (kind === "child") words.argv.push(tok);
  if (kind === "unknown") words.unverifiable.push(`runner-option:${flag}`);
  if (kind === "package" || kind === "call" || kind === "value") {
    const value = equals < 0 ? (tokens[++i] ?? "") : tok.slice(equals + 1);
    if (equals < 0) words.optionTokens.push(value);
    if (kind === "package") words.packages.push(value);
    if (kind === "call") {
      words.call = true;
      words.unverifiable.push(`runner-command:${manager} ${flag}`);
    }
  }
  return i;
}

function finishRunner(words: RunnerWords): NpmRunnerInvocation {
  const child = unwrapCommandWrappers(words.call ? [] : words.argv);
  const inferred = words.packages.length === 0 && !words.call;
  return {
    packages: inferred ? words.argv.slice(0, 1) : words.packages,
    argv: child.argv,
    shadowable: inferred && words.argv.length > 0,
    optionTokens: words.optionTokens,
    unverifiable: [...words.unverifiable, ...child.unverifiable],
  };
}

/** Parse npm/npx options once for package triage, repository inspection and local binary checks. */
export function npmRunnerInvocation(tokens: readonly string[]): NpmRunnerInvocation | null {
  const manager = tokens[0];
  if (manager !== "npm" && manager !== "npx") return null;
  const words: RunnerWords = {
    packages: [],
    argv: [],
    optionTokens: [],
    unverifiable: [],
    call: false,
  };
  let needsVerb = manager === "npm";
  let options = true;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (options && tok === "--") {
      options = false;
    } else if (options && tok.startsWith("-")) {
      i = consumeRunnerOption(manager, tokens, i, words);
    } else if (needsVerb) {
      if (tok !== "exec" && tok !== "x") return null;
      needsVerb = false;
    } else {
      words.argv.push(tok);
      // npx forwards every word after the command. npm parses options until an explicit --.
      if (manager === "npx") options = false;
    }
  }
  return needsVerb ? null : finishRunner(words);
}

const REPO_AUTHORITIES: Record<string, RegExp> = {
  http: /^(?:www\.)?github\.com(?::80)?$/i,
  https: /^(?:www\.)?github\.com(?::443)?$/i,
  "git+https": /^github\.com(?::443)?$/i,
  ssh: /^(?:git@)?github\.com(?::22)?$/i,
  "git+ssh": /^(?:git@)?github\.com(?::22)?$/i,
  git: /^github\.com(?::9418)?$/i,
};

/** Check raw authorities before normalization can hide userinfo or an encoded host. */
function githubSourcePath(source: string): { path: string; subpath: boolean } | null {
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)\/(.+)$/i.exec(source);
  if (url) {
    const scheme = url[1].toLowerCase();
    if (!Object.hasOwn(REPO_AUTHORITIES, scheme) || !REPO_AUTHORITIES[scheme].test(url[2])) {
      return null;
    }
    return { path: url[3], subpath: scheme === "https" || scheme === "http" };
  }
  const hosted = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(source);
  if (hosted) return { path: hosted[1], subpath: true };
  const ssh = /^git@github\.com:(.+)$/i.exec(source);
  return { path: ssh ? ssh[1] : source, subpath: false };
}

/** Convert only explicit GitHub sources or GitHub shorthand to `owner/repo`. */
export function ownerRepoArg(source: string): string | null {
  if (/\s/.test(source)) return null;
  const github = githubSourcePath(source);
  if (!github) return null;
  const { path, subpath } = github;
  const parts = path.replace(/\/$/, "").split("/");
  if (parts.length < 2 || (!subpath && parts.length !== 2)) return null;
  if (parts.slice(0, 2).some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) {
    return null;
  }
  if (parts.slice(2).some((part) => !safeRepoSubpathSegment(part))) return null;
  const [owner, name] = parts;
  const repo = name.replace(/\.git$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(owner) || !repo || repo === "." || repo === "..") {
    return null;
  }
  return `${owner}/${repo}`;
}

/** Subpaths can contain URL characters that repository names cannot contain. */
function safeRepoSubpathSegment(part: string): boolean {
  if (!part || /[\\?#]/.test(part)) return false;
  try {
    // Decode for validation only. Refuse hidden separators, traversal, controls and nested escapes.
    const decoded = decodeURIComponent(part);
    return (
      decoded !== "." &&
      decoded !== ".." &&
      !/[\\/]/.test(decoded) &&
      !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(decoded) &&
      !/%[0-9a-f]{2}/i.test(decoded)
    );
  } catch {
    return false;
  }
}

/** A protocol-relative source is ambiguous and must not take the local-path exemption. */
function localRepoSource(source: string): boolean {
  return /^[./~]/.test(source) && !source.startsWith("//");
}

const PLUGIN_BINS = new Set(["plugin", "plugins"]);

/** Mask userinfo and opaque query/fragment data after classification. Keep the host and path. */
function rejectedSourceDisplay(source: string): string {
  const address = source.replace(/^((?:[a-z][a-z0-9+.-]*:)?\/+)?[^/]*(?:@|%40)/i, "$1[redacted]@");
  return address.replace(/([?#])[\s\S]*$/, "$1[redacted]");
}

/** Keep unsupported remote sources visible so the gate refuses them before triage. */
export function repoSourceArg(source: string): { ref: string } | { unverifiable: string } | null {
  if (!source || source.startsWith("-") || source.startsWith("@")) return null;
  // The shell expands these before the installer reads them, so the value that is fetched is not
  // the text the gate sees. Check this before the local-path rule: `./$X` is not a fixed path.
  if (/[$`{*?]/.test(source)) {
    return { unverifiable: `repo-source:${rejectedSourceDisplay(source)}` };
  }
  if (localRepoSource(source)) return null;
  const repo = ownerRepoArg(source);
  if (repo) return { ref: `github:${repo}` };
  if (/[:@/]/.test(source)) {
    return { unverifiable: `repo-source:${rejectedSourceDisplay(source)}` };
  }
  return null;
}

/**
 * `claude plugin marketplace add <source>` and `claude plugin install <plugin> --marketplace
 * <source>` add a marketplace: a repo whose plugins run INSIDE the agent. A plugin's hooks module
 * can drop a prompt, submit text as the user and send billed model requests, more authority than
 * most npm packages, and `claude plugin install` passed this gate silently while `npx skills add`
 * did not. Adding the marketplace is the trust decision, so that is what is triaged:
 *
 *   - a GitHub repo (`owner/repo`, `https://github.com/owner/repo`, `git@github.com:…`) → `github:` ref;
 *   - a local path → the user's own code, nothing to triage;
 *   - anything else (another host, a URL to a marketplace.json) → unverifiable, fail-closed.
 *
 * `claude plugin install <plugin>@<marketplace>` names a marketplace added earlier, which was
 * triaged when it was added, so it is not an add. `/plugin install` typed inside Claude Code is a
 * slash command and never reaches a Bash hook; this covers the shell form only.
 */
export function claudePluginInstall(tokens: readonly string[], probe: InstallProbe): boolean {
  if (tokens[0] !== "claude" || !PLUGIN_BINS.has(tokens[1] ?? "")) return false;
  const rest = tokens.slice(2);
  let source: string | undefined;
  if (rest[0] === "marketplace" && rest[1] === "add") {
    source = rest.slice(2).find((t) => !t.startsWith("-"));
    if (source === undefined) {
      probe.isInstall = true;
      probe.unverifiable.push("claude-plugin-marketplace:<none>");
      return true;
    }
  } else if (rest[0] === "install" || rest[0] === "i") {
    source = marketplaceFlag(rest);
    if (source === undefined) return true; // a marketplace added (and triaged) earlier
  } else {
    return true; // list, remove, update, validate: nothing new is fetched from a new source
  }
  if (localRepoSource(source)) return true; // the user's own marketplace on disk
  probe.isInstall = true;
  const repo = githubOnly(source);
  if (repo) probe.refs.push(`github:${repo}`);
  else probe.unverifiable.push(`claude-plugin-marketplace:${rejectedSourceDisplay(source)}`);
  return true;
}

function marketplaceFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const eq = /^--marketplace=(.+)$/.exec(args[i]);
    if (eq) return eq[1];
    if (args[i] === "--marketplace") return args[i + 1] ?? "";
  }
  return undefined;
}

/** `owner/repo` only when the source is on GitHub; another host must not become a github: ref. */
function githubOnly(source: string): string | null {
  if (/\.json$/i.test(source)) return null;
  return ownerRepoArg(source);
}
