/**
 * A bare `npm install` names no package, so the install gate has no name to triage. In a repository
 * that is fine: `kit triage check-deps` gates a new dependency when the manifest is committed. Where
 * git does not track the manifest (a Claude Code skill, an unpacked download, a scratch folder) no
 * commit ever gates it, and the install would fetch every declared dependency untriaged.
 *
 * This module closes that case. A bare install in such a directory needs a fresh triage receipt
 * (`.kit-triage.jsonl`, the same file and window `check-deps` uses) for every direct dependency.
 * Transitive dependencies are not triaged here, and a tracked manifest is left to `check-deps`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDirectoryValueFlag } from "./install-gate-flags.js";
import { TRIAGE_LOG_FILE, TRIAGE_MAX_AGE_DAYS } from "./triage-receipt.js";

export interface BareVerdict {
  block: boolean;
  reason: string;
}

type Directory = { dir: string } | { unresolved: string };

const LEADING_CD = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;
const DYNAMIC = /[$`*?[\]{}()<>|&;!\n]/;

function literalPath(token: string, base: string): string | undefined {
  const bare = token.replace(/^(["'])(.*)\1$/, "$2");
  const home = bare.replace(/^~(?=\/|$)/, homedir()).replace(/^\$HOME(?=\/|$)/, homedir());
  if (home === "" || DYNAMIC.test(home)) return undefined;
  return resolve(base, home);
}

// An environment assignment or `env -C` that moves npm to a directory this module cannot see.
const MOVES_NPM =
  /(?:^|[\s;&|(])(?:NPM_CONFIG_\w*|npm_config_\w*)=|(?:^|[\s;&|(])env\s+(?:\S+\s+)*?(?:-C|--chdir)\b/;

/** One package-less install the gate parsed: the manager and the command's own tokens. */
export interface BareSegment {
  manager: string;
  tokens: string[];
}

const EQUALS_FLAGS = ["--prefix", "-C", "--dir", "--cwd"];

/** The directory flag values in a parsed install command. `undefined` marks a flag with no value. */
function directoryValues(segment: BareSegment): (string | undefined)[] {
  const { manager, tokens } = segment;
  const values: (string | undefined)[] = [];
  tokens.forEach((token, i) => {
    if (isDirectoryValueFlag(token, manager)) values.push(tokens[i + 1]);
    for (const flag of EQUALS_FLAGS) {
      if (token.startsWith(`${flag}=`) && isDirectoryValueFlag(flag, manager)) {
        values.push(token.slice(flag.length + 1));
      }
    }
  });
  return values;
}

/** The directory a bare install runs in: the caller's, moved by leading `cd` steps or one directory flag. */
export function installDirectory(command: string, cwd: string, segments: BareSegment[]): Directory {
  let dir = cwd;
  let rest = command;
  for (let match = LEADING_CD.exec(rest); match; match = LEADING_CD.exec(rest)) {
    const next = literalPath(match[1], dir);
    if (!next) return { unresolved: `cd ${match[1]}` };
    dir = next;
    rest = rest.slice(match[0].length);
  }
  if (/(?:^|[\s;&|(])(?:cd|pushd|popd)(?:\s|$)/.test(rest)) {
    return { unresolved: "a cd that does not lead the command" };
  }
  if (segments.length > 1) return { unresolved: "more than one bare install in the command" };
  if (MOVES_NPM.test(rest)) return { unresolved: "an environment or env -C that moves npm" };
  const flags = segments.flatMap(directoryValues);
  if (flags.length > 1) return { unresolved: "more than one directory flag" };
  if (flags.length === 1) {
    const value = flags[0];
    const next = value === undefined ? undefined : literalPath(value, dir);
    return next ? { dir: next } : { unresolved: `directory flag ${value ?? "without a value"}` };
  }
  return { dir };
}

function isTracked(dir: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "package.json"], {
      cwd: dir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

type Direct = { name: string } | { refused: string };

const LOCAL = /^(?:file|link|workspace|portal):/;
const REMOTE =
  /^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|gist:|https?:|ssh:)|^[\w.-]+\/[\w.-]+(?:#.*)?$/i;

function classify(name: string, spec: unknown): Direct | undefined {
  if (typeof spec !== "string") return { refused: `${name} (version is not a string)` };
  if (LOCAL.test(spec)) return undefined;
  if (REMOTE.test(spec)) return { refused: `${name} (${spec} has no registry triage)` };
  const alias = /^npm:(@?[^@]+)(?:@.*)?$/.exec(spec);
  return { name: alias ? alias[1] : name };
}

function directDependencies(manifest: unknown): Direct[] {
  const found: Direct[] = [];
  const object = manifest as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const group = object[field];
    if (group === undefined) continue;
    if (group === null || typeof group !== "object" || Array.isArray(group)) {
      found.push({ refused: `${field} (not an object)` });
      continue;
    }
    for (const [name, spec] of Object.entries(group)) {
      const entry = classify(name, spec);
      if (entry) found.push(entry);
    }
  }
  return found;
}

function freshReceipts(dir: string): Set<string> {
  const file = join(dir, TRIAGE_LOG_FILE);
  const names = new Set<string>();
  if (!existsSync(file)) return names;
  const cutoff = Date.now() - TRIAGE_MAX_AGE_DAYS * 24 * 3600 * 1000;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line) as { type?: unknown; target?: unknown; timestamp?: unknown };
      if (entry.type !== "npm" || typeof entry.target !== "string") continue;
      if (typeof entry.timestamp !== "string" || Date.parse(entry.timestamp) < cutoff) continue;
      const at = entry.target.lastIndexOf("@");
      names.add(at > 0 ? entry.target.slice(0, at) : entry.target);
    } catch {
      /* a line that is not a receipt proves nothing */
    }
  }
  return names;
}

function refusal(dir: string, detail: string): BareVerdict {
  return {
    block: true,
    reason: `bare install in ${dir}: ${detail} (fail-closed)`,
  };
}

// Config a package manager reads from the folder, and lockfiles this module does not parse.
const STEERING_FILES = [
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
];

const DEFAULT_REGISTRIES = ["https://registry.npmjs.org/", "https://registry.yarnpkg.com/"];
const fromDefaultRegistry = (url: string): boolean =>
  DEFAULT_REGISTRIES.some((prefix) => url.startsWith(prefix));

/** Every `resolved` string in an npm lockfile, however deeply `dependencies` nest. */
function resolvedUrls(lock: unknown): string[] {
  const urls: string[] = [];
  const stack: unknown[] = [lock];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === "resolved" && typeof value === "string") urls.push(value);
      else stack.push(value);
    }
  }
  return urls;
}

/** Why a lockfile in `dir` cannot be trusted to name only the default registry, or undefined. */
function lockfileSourceProblem(dir: string): string | undefined {
  for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const urls = resolvedUrls(JSON.parse(readFileSync(path, "utf8")));
      if (!urls.every(fromDefaultRegistry))
        return `${name} resolves a package from outside the default registry`;
    } catch {
      return `${name} cannot be read`;
    }
  }
  for (const name of ["yarn.lock", "pnpm-lock.yaml"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const urls = [
      ...readFileSync(path, "utf8").matchAll(/^\s*(?:resolved\s+"?|tarball:\s*"?)(\S+?)"?\s*$/gm),
    ];
    if (!urls.every((m) => fromDefaultRegistry(m[1])))
      return `${name} resolves a package from outside the default registry`;
  }
  return undefined;
}

/** Decide a bare install. Pure apart from reading the manifest, the receipts and `git ls-files`. */
export function checkBareInstall(
  command: string,
  cwd: string,
  segments: BareSegment[],
): BareVerdict {
  const where = installDirectory(command, cwd, segments);
  if ("unresolved" in where) {
    return refusal(cwd, `cannot tell which directory is installed (${where.unresolved})`);
  }
  const { dir } = where;
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return { block: false, reason: "no package.json to install" };
  if (isTracked(dir)) {
    return { block: false, reason: "manifest is tracked by git; `kit triage check-deps` gates it" };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return refusal(dir, "package.json cannot be read");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return refusal(dir, "package.json is not an object");
  }
  // A folder's own .npmrc can name another registry or scope registry, and the lockfile can pin a
  // package to a URL elsewhere. Receipts are for names on the default registry; neither is covered.
  const steering = STEERING_FILES.find((name) => existsSync(join(dir, name)));
  if (steering) {
    return refusal(
      dir,
      `the folder holds ${steering}, which can redirect the install or is not read`,
    );
  }
  const lockProblem = lockfileSourceProblem(dir);
  if (lockProblem) return refusal(dir, `the lockfile cannot be trusted: ${lockProblem}`);
  const direct = directDependencies(manifest);
  const refused = direct.flatMap((d) => ("refused" in d ? [d.refused] : []));
  if (refused.length > 0) return refusal(dir, `cannot triage ${refused.join(", ")}`);
  const have = freshReceipts(dir);
  const missing = [
    ...new Set(direct.flatMap((d) => ("name" in d && !have.has(d.name) ? [d.name] : []))),
  ];
  if (missing.length === 0) return { block: false, reason: "direct dependencies triaged" };
  return {
    block: true,
    reason:
      `bare install in ${dir}: no fresh triage receipt (${TRIAGE_MAX_AGE_DAYS} days) for ` +
      `${missing.join(", ")}. Run \`cd ${dir} && kit triage npm ${missing.join(" ")}\` first`,
  };
}
