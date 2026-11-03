/**
 * Daily watch (zero-trust plan Z4): ranks open security PRs, caches the result for the
 * status line and schedules itself. `gatherWatch` only reads `gh`; it never writes to
 * GitHub (ADR-0009: kit reads cloud reports and holds no cloud credential of its own).
 * A missing source gives `unverified`, never an empty green list.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  rankSecurityPrs,
  securityPrsLine,
  type OpenPr,
  type RankedPr,
  type SecurityAlert,
  type Severity,
} from "./security-prs.js";

export const WATCH_CACHE = ".kit/watch.json";
export const WATCH_STALE_MS = 48 * 3_600_000;

export interface WatchCache {
  at: string;
  repo: string;
  ranked: RankedPr[];
  unverified?: string;
}

export type GhRunner = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

const SEVERITY_SET = new Set<string>(["critical", "high", "medium", "low"]);
const CI_SET = new Set<string>(["failing", "pending", "passing", "none"]);

function validRanked(v: unknown): RankedPr[] {
  if (!Array.isArray(v)) return [];
  const out: RankedPr[] = [];
  for (const r of v as Partial<RankedPr>[]) {
    if (
      Number.isInteger(r?.number) &&
      SEVERITY_SET.has(String(r.severity)) &&
      CI_SET.has(String(r.ci)) &&
      typeof r.title === "string" &&
      typeof r.updatedAt === "string"
    ) {
      out.push(r as RankedPr);
    }
  }
  return out;
}

/**
 * Read the cache written by `kit watch run`; null when absent or unreadable. The file sits
 * in the working tree, so a hostile checkout can plant it: only known severity and CI
 * values and integer PR numbers survive, and the repo name is not shown.
 */
export function readWatchCache(cwd: string): WatchCache | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(resolve(cwd, WATCH_CACHE), "utf8"));
    const c = raw as Partial<WatchCache> | null;
    if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.at !== "string") return null;
    return {
      at: c.at,
      repo: typeof c.repo === "string" ? c.repo : "",
      ranked: validRanked(c.ranked),
      ...(typeof c.unverified === "string" ? { unverified: c.unverified } : {}),
    };
  } catch {
    return null;
  }
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error(`refusing to write through a symlink: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Write the cache without following a symlink at `.kit` or `.kit/watch.json`. */
export function writeWatchCache(cwd: string, cache: WatchCache): void {
  const path = resolve(cwd, WATCH_CACHE);
  assertNotSymlink(dirname(path));
  mkdirSync(dirname(path), { recursive: true });
  assertNotSymlink(dirname(path));
  assertNotSymlink(path);
  // A rename replaces a link at `path` instead of writing through it.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { flag: "wx" });
  renameSync(tmp, path);
}

/** The status-line segment for a cache; null = stay quiet. */
export function watchSegment(cache: WatchCache | null, now: number): string | null {
  if (!cache) return null;
  const age = now - Date.parse(cache.at);
  if (!Number.isFinite(age) || age > WATCH_STALE_MS) return "sec-prs:stale";
  if (cache.unverified) return "sec-prs:unverified";
  return securityPrsLine(cache.ranked);
}

/** PAL titles to open: critical and high PRs without an open item for the same PR number. */
export function palTitlesFor(ranked: RankedPr[], openTitles: string[]): string[] {
  const titles: string[] = [];
  for (const pr of ranked) {
    if (pr.severity !== "critical" && pr.severity !== "high") continue;
    if (openTitles.some((t) => t.startsWith(`Security PR #${pr.number} `))) continue;
    titles.push(`Security PR #${pr.number} (${pr.severity}, ci:${pr.ci}): ${pr.title}`);
  }
  return titles;
}

interface RawPr {
  number: number;
  title: string;
  updatedAt: string;
  author?: { login?: string; is_bot?: boolean };
  statusCheckRollup?: { conclusion?: string | null; status?: string; state?: string }[];
}
interface RawAlert {
  security_vulnerability?: {
    package?: { name?: string };
    first_patched_version?: { identifier?: string } | null;
  };
  security_advisory?: { severity?: string };
}

const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);

function toOpenPr(raw: RawPr): OpenPr {
  return {
    number: raw.number,
    title: raw.title,
    updatedAt: raw.updatedAt,
    author: raw.author?.login
      ? { login: raw.author.login, isBot: raw.author.is_bot === true }
      : undefined,
    // A finished check reports its conclusion; an unfinished one its status.
    checks: (raw.statusCheckRollup ?? []).map((c) => ({
      state: (c.conclusion || c.status || c.state || "PENDING").toUpperCase(),
    })),
  };
}

function toAlerts(raw: RawAlert[]): SecurityAlert[] {
  const out: SecurityAlert[] = [];
  for (const a of raw) {
    const name = a.security_vulnerability?.package?.name;
    const patched = a.security_vulnerability?.first_patched_version?.identifier;
    const severity = a.security_advisory?.severity;
    if (name && patched && severity && SEVERITIES.has(severity)) {
      out.push({ name, patched, severity: severity as Severity });
    }
  }
  return out;
}

function parseList<T>(res: { ok: boolean; stdout: string }): T[] | null {
  if (!res.ok) return null;
  try {
    const v: unknown = JSON.parse(res.stdout);
    return Array.isArray(v) ? (v as T[]) : null;
  } catch {
    return null;
  }
}

export async function gatherWatch(gh: GhRunner, now: () => number): Promise<WatchCache> {
  const at = new Date(now()).toISOString();
  const repoRes = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const repo = repoRes.stdout.trim();
  if (!repoRes.ok || !repo) {
    return { at, repo: "", ranked: [], unverified: "gh cannot name the repository" };
  }
  const prs = parseList<RawPr>(
    await gh([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,updatedAt,author,statusCheckRollup",
    ]),
  );
  if (!prs) return { at, repo, ranked: [], unverified: "gh could not list open PRs" };
  const alerts = parseList<RawAlert>(
    await gh(["api", `repos/${repo}/dependabot/alerts?state=open&per_page=100`]),
  );
  if (!alerts) return { at, repo, ranked: [], unverified: "no dependabot alerts access" };
  return { at, repo, ranked: rankSecurityPrs(prs.map(toOpenPr), toAlerts(alerts)) };
}

// ── Scheduler entries ──────────────────────────────────────────────────────

export interface ScheduleOptions {
  /** Program and leading arguments that start kit, e.g. [node, /path/cli.js]. */
  command: string[];
  cwd: string;
  hour: number;
  minute: number;
}

const xml = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const sh = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

export function launchdPlist(o: ScheduleOptions & { label: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${o.command.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
    <string>watch</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.cwd)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${o.hour}</integer>
    <key>Minute</key>
    <integer>${o.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.logPath)}</string>
</dict>
</plist>
`;
}

export function cronLine(o: ScheduleOptions): string {
  return `${o.minute} ${o.hour} * * * cd ${sh(o.cwd)} && ${o.command.map(sh).join(" ")} watch run >/dev/null 2>&1`;
}

/** Read-only scheduled workflow: it caches nothing across runs, so it prints the ranking. */
export function watchWorkflow(schedule = "17 6 * * *"): string {
  return `# Generated by \`kit watch install\`. Daily read-only ranking of open security PRs.
name: kit-watch
on:
  schedule:
    - cron: "${schedule}"
  workflow_dispatch: {}
permissions:
  contents: read
  pull-requests: read
  security-events: read
jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: kit watch run
        run: npx --yes sandstream-kit watch run --json --no-pal
        env:
          GH_TOKEN: \${{ github.token }}
`;
}
