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

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_BUDGET_MS = 15_000;
// Only npm for now: `npm audit` and `npm outdated` read package-lock.json.
const LOCKFILES = ["package-lock.json"];
const SEVERITIES: Severity[] = ["critical", "high", "moderate", "low", "info"];

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
  const parts: string[] = [];
  if (r.vulnerabilities.length > 0) {
    const n = r.vulnerabilities.length;
    const packages = [...new Set(r.vulnerabilities.map((v) => v.package))].join(", ");
    parts.push(
      `${n} known vulnerabilit${n === 1 ? "y" : "ies"} (${severityCounts(r.vulnerabilities)}) in ${packages}`,
    );
  }
  if (r.majorsBehind.length > 0) {
    const list = r.majorsBehind
      .map((b) => `${b.package} ${b.current} (latest ${b.latest})`)
      .join(", ");
    parts.push(`a major version behind: ${list}`);
  }
  if (parts.length === 0) return undefined;
  return (
    `kit: skill "${name}" (${dir}) has npm dependencies that need attention: ${parts.join("; ")}. ` +
    `Change the versions in package.json, run \`kit triage npm <name>@<version>\` for each new version, ` +
    `then \`npm install\` in that folder.`
  );
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
    let hash: string;
    try {
      hash = lockHash(dir);
    } catch {
      continue;
    }
    const hit = cache[dir];
    let result: SkillDepsCheck | undefined;
    if (hit && hit.lockHash === hash && deps.now() < hit.checkedAt + DAY_MS) result = hit.result;
    if (!result) {
      if (deps.now() - started >= budget) {
        skipped += 1;
        continue;
      }
      try {
        result = deps.check(dir);
      } catch {
        continue; // offline or a broken tool: say nothing, check again next session
      }
      cache[dir] = { checkedAt: deps.now(), lockHash: hash, result };
      dirty = true;
    }
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
    env: { ...process.env, NO_COLOR: "1" },
  });
  const text = (r.stdout ?? "").trim();
  if (r.error || !text.startsWith("{")) return [];
  try {
    const data = JSON.parse(text) as Record<string, { current?: string; latest?: string }>;
    return Object.entries(data).flatMap(([name, v]) =>
      typeof v?.current === "string" &&
      typeof v.latest === "string" &&
      majorOf(v.latest) > majorOf(v.current)
        ? [{ package: name, current: v.current, latest: v.latest }]
        : [],
    );
  } catch {
    return [];
  }
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
