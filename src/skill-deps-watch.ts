/**
 * Watch the npm dependencies that Claude Code skills carry.
 *
 * A skill may ship its own `package.json` and `node_modules` (`~/.claude/skills/<name>/scripts`).
 * Nothing updates those on its own: versions stay where `npm install` left them, so an advisory
 * published later reaches no one. This module runs `npm audit` and `npm outdated` in each such
 * folder and returns one plain line per skill that needs attention.
 *
 * It is meant for a session-start hook, so it is quiet and cheap: silent when everything is fine or
 * when the network is unavailable, one network pass per skill per day (cached by lockfile hash),
 * and a time budget for the whole run. It reads and reports. It never installs, updates or removes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { runAudit, type Severity } from "./advisory-baseline.js";

export interface Vulnerability {
  package: string;
  severity: Severity;
  title: string;
}
export interface Behind {
  package: string;
  current: string;
  latest: string;
}
export interface SkillDepsCheck {
  vulnerabilities: Vulnerability[];
  majorsBehind: Behind[];
}
export interface WatchDeps {
  now: () => number;
  check: (dir: string) => SkillDepsCheck;
}
export interface WatchOptions {
  /** Skill roots, for example `~/.claude/skills` and `<project>/.claude/skills`. */
  roots: string[];
  /** Where results are cached between sessions. */
  cache: string;
  /** Write nothing. The result is still reported. */
  readOnly?: boolean;
  /** Stop starting new checks after this many milliseconds. */
  budgetMs?: number;
}

const SECRET_NAME = /token|secret|key|password|passwd|auth|credential|^npm_config_/i;

/** The environment npm receives: no tokens, keys or npm config, so a registry named in a skill's
 *  own files cannot be sent a secret through `${VAR}` interpolation. */
export function safeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_NAME.test(name)) out[name] = value;
  }
  out.NO_COLOR = "1";
  return out;
}

// What reaches the agent's context must be a name or a version, never free text from a skill.
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
const safePackage = (name: string): boolean => name.length <= 214 && PACKAGE_NAME.test(name);
const safeVersion = (v: string): boolean => v.length <= 80 && VERSION.test(v);
const safeSeverity = (s: string): Severity =>
  SEVERITIES.includes(s as Severity) ? (s as Severity) : "info";
/** Printable text only: a folder name with a newline or an escape sequence is shown with `?`. */
const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);

const SEVERITIES: Severity[] = ["critical", "high", "moderate", "low", "info"];
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_BUDGET_MS = 15_000;
// Only npm for now: `npm audit` and `npm outdated` read package-lock.json.
const LOCKFILES = ["package-lock.json"];

function lockfileOf(dir: string): string | undefined {
  return LOCKFILES.find((name) => existsSync(join(dir, name)));
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** Folders with a `package.json` and a lockfile directly in a skill or in one folder below it. */
export function findSkillProjects(roots: string[]): string[] {
  const found = new Set<string>();
  for (const root of roots) {
    for (const skill of subdirectories(root)) {
      for (const dir of [skill, ...subdirectories(skill)]) {
        if (existsSync(join(dir, "package.json")) && lockfileOf(dir)) found.add(dir);
      }
    }
  }
  return [...found];
}

interface CacheEntry {
  checkedAt: number;
  lockHash: string;
  result: SkillDepsCheck;
}
type Cache = Record<string, CacheEntry>;

function readCache(path: string): Cache {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Cache)
      : {};
  } catch {
    return {};
  }
}

function writeCache(path: string, cache: Cache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf8");
  } catch {
    /* a cache that cannot be written only costs a repeat check */
  }
}

function lockHash(dir: string): string {
  const lock = lockfileOf(dir);
  return createHash("sha256")
    .update(lock ? readFileSync(join(dir, lock)) : "")
    .digest("hex");
}

function skillNameOf(dir: string, roots: string[]): string {
  for (const root of roots) {
    const rel = relative(root, dir);
    if (!rel.startsWith("..") && rel !== "") return rel.split(sep)[0];
  }
  return dir;
}

function severityCounts(items: Vulnerability[]): string {
  return SEVERITIES.map((s) => [s, items.filter((v) => v.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}

function describe(name: string, dir: string, r: SkillDepsCheck): string | undefined {
  const vulnerabilities = r.vulnerabilities
    .filter((v) => safePackage(v.package))
    .map((v) => ({ ...v, severity: safeSeverity(v.severity) }));
  const behind = r.majorsBehind.filter(
    (b) => safePackage(b.package) && safeVersion(b.current) && safeVersion(b.latest),
  );
  const parts: string[] = [];
  if (vulnerabilities.length > 0) {
    const n = vulnerabilities.length;
    const packages = [...new Set(vulnerabilities.map((v) => v.package))].join(", ");
    parts.push(
      `${n} known vulnerabilit${n === 1 ? "y" : "ies"} (${severityCounts(vulnerabilities)}) in ${packages}`,
    );
  }
  if (behind.length > 0) {
    const list = behind.map((b) => `${b.package} ${b.current} (latest ${b.latest})`).join(", ");
    parts.push(`a major version behind: ${list}`);
  }
  if (parts.length === 0) return undefined;
  return (
    `kit: skill "${printable(name)}" (${printable(dir)}) has npm dependencies that need attention: ${parts.join("; ")}. ` +
    `Change the versions in package.json, run \`kit triage npm <name>@<version>\` for each new version, ` +
    `then \`npm install\` in that folder.`
  );
}

function npmrcNote(dir: string, roots: string[]): string | undefined {
  // A folder's own .npmrc can name another registry or read a token from the environment, and npm
  // would follow it. Do not run npm there.
  if (!existsSync(join(dir, ".npmrc"))) return undefined;
  return `kit: skill "${printable(skillNameOf(dir, roots))}" has its own .npmrc, so its npm dependencies are not checked. Check them by hand with \`kit triage npm\`.`;
}

function safeLockHash(dir: string): string | undefined {
  try {
    return lockHash(dir);
  } catch {
    return undefined;
  }
}

type Looked = { result: SkillDepsCheck; fresh: boolean } | "over-budget" | "failed";

/** A cached result that is under a day old and matches the lockfile, else a new check if time allows. */
function lookup(
  cache: Cache,
  dir: string,
  hash: string,
  deps: WatchDeps,
  started: number,
  budget: number,
): Looked {
  const hit = cache[dir];
  if (hit && hit.lockHash === hash && deps.now() < hit.checkedAt + DAY_MS) {
    return { result: hit.result, fresh: false };
  }
  if (deps.now() - started >= budget) return "over-budget";
  try {
    return { result: deps.check(dir), fresh: true };
  } catch {
    return "failed";
  }
}

/** The notes to show at session start, one line per skill that needs attention. Never throws. */
export function watchSkillDeps(options: WatchOptions, deps: WatchDeps): string[] {
  const started = deps.now();
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const cache = readCache(options.cache);
  const notes: string[] = [];
  let skipped = 0;
  let dirty = false;
  for (const dir of findSkillProjects(options.roots)) {
    const refusal = npmrcNote(dir, options.roots);
    if (refusal) {
      notes.push(refusal);
      continue;
    }
    const hash = safeLockHash(dir);
    if (hash === undefined) continue;
    const got = lookup(cache, dir, hash, deps, started, budget);
    if (got === "over-budget") {
      skipped += 1;
      continue;
    }
    if (got === "failed") continue; // offline or a broken tool: say nothing, check again next session
    if (got.fresh) {
      cache[dir] = { checkedAt: deps.now(), lockHash: hash, result: got.result };
      dirty = true;
    }
    const result = got.result;
    const note = describe(skillNameOf(dir, options.roots), dir, result);
    if (note) notes.push(note);
  }
  if (dirty && !options.readOnly) writeCache(options.cache, cache);
  if (skipped > 0) {
    notes.push(
      `kit: ${skipped} skill folder${skipped === 1 ? "" : "s"} with npm dependencies not checked: the time budget was spent. They are checked at the next session start.`,
    );
  }
  return notes;
}

const CHECK_TIMEOUT_MS = 8000;

function majorOf(version: string): number {
  return Number.parseInt(version.split(".")[0] ?? "", 10);
}

function outdatedMajors(dir: string): Behind[] {
  const r = spawnSync("npm", ["outdated", "--json"], {
    cwd: dir,
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    env: safeEnv(process.env),
  });
  // Exit 1 with a JSON object is the normal "something is outdated". Anything that did not run to
  // the end must not be cached as "nothing is outdated".
  if (r.error || r.status === null) throw new Error("npm outdated did not finish");
  const text = (r.stdout ?? "").trim();
  if (text === "") {
    if (r.status === 0) return [];
    throw new Error("npm outdated failed");
  }
  if (!text.startsWith("{")) throw new Error("npm outdated gave no JSON");
  const data = JSON.parse(text) as Record<string, { current?: string; latest?: string }>;
  if ("error" in data) throw new Error("npm outdated reported an error");
  return Object.entries(data).flatMap(([name, v]) =>
    typeof v?.current === "string" &&
    typeof v.latest === "string" &&
    majorOf(v.latest) > majorOf(v.current)
      ? [{ package: name, current: v.current, latest: v.latest }]
      : [],
  );
}

/** The real check: `npm audit` for advisories, `npm outdated` for majors. Throws when the audit cannot run. */
export function checkWithNpm(dir: string): SkillDepsCheck {
  const outcome = runAudit(
    dir,
    { manager: "npm", command: ["npm", "audit", "--json"] },
    CHECK_TIMEOUT_MS,
  );
  if (outcome.error) throw new Error(outcome.error);
  return {
    vulnerabilities: outcome.advisories.map((a) => ({
      package: a.package,
      severity: a.severity,
      title: a.title,
    })),
    majorsBehind: outdatedMajors(dir),
  };
}

export const realDeps: WatchDeps = { now: () => Date.now(), check: checkWithNpm };
