/**
 * Daily watch (zero-trust plan Z4): ranks open security PRs, caches the result for the
 * status line and schedules itself. `gatherWatch` only reads `gh`; it never writes to
 * GitHub (ADR-0009: kit reads cloud reports and holds no cloud credential of its own).
 * A missing source gives `unverified`, never an empty green list.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { kitConfig } from "./config.js";
import {
  rankSecurityPrs,
  securityPrsLine,
  type OpenPr,
  type RankedPr,
  type SecurityAlert,
  type Severity,
} from "./security-prs.js";

const WATCH_CACHE = ".kit/watch.json";
const WATCH_STALE_MS = 48 * 3_600_000;

export interface WatchCache {
  at: string;
  repo: string;
  ranked: RankedPr[];
  unverified?: string;
  /** Why CISA KEV did not mark the ranking this run (the ranking itself still holds). */
  kevNote?: string;
}

/** CVE ids → the ones in CISA KEV, plus a note when KEV could not be checked. */
export type KevLookup = (cves: string[]) => Promise<{ kev: Set<string>; note?: string }>;

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
      const { kev, ...rest } = r as RankedPr;
      out.push(kev === true ? { ...rest, kev: true } : rest);
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
      ...(typeof c.kevNote === "string" ? { kevNote: c.kevNote.slice(0, 200) } : {}),
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
    if (!pr.kev && pr.severity !== "critical" && pr.severity !== "high") continue;
    if (openTitles.some((t) => t.startsWith(`Security PR #${pr.number} `))) continue;
    const kev = pr.kev ? "KEV, " : "";
    titles.push(`Security PR #${pr.number} (${kev}${pr.severity}, ci:${pr.ci}): ${pr.title}`);
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
  security_advisory?: { severity?: string; cve_id?: string | null };
}

const CVE_ID = /^CVE-\d{4}-\d{4,7}$/;

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
    const cve = a.security_advisory?.cve_id?.toUpperCase();
    if (name && patched && severity && SEVERITIES.has(severity)) {
      out.push({
        name,
        patched,
        severity: severity as Severity,
        ...(cve && CVE_ID.test(cve) ? { cve } : {}),
      });
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

/** The project settings the KEV lookup honors: `[air_gap]` and `[scan] exploit_intel`. */
export interface KevSettings {
  air_gap?: kitConfig["air_gap"];
  scan?: { exploit_intel?: boolean };
}

/**
 * The real lookup: CISA KEV through the shared exploit-intel cache. Off with
 * `[scan] exploit_intel = false` or KIT_EXPLOIT_INTEL=0; air gap (config or env) reads only the cache.
 */
export function kevLookupFor(settings: KevSettings): KevLookup {
  return async (cves) => {
    if (settings.scan?.exploit_intel === false || process.env.KIT_EXPLOIT_INTEL === "0") {
      return { kev: new Set() };
    }
    const { defaultIntelDeps, loadExploitIntel } = await import("./exploit-intel.js");
    const { resolveAirGap } = await import("./airgap/config.js");
    const offline = resolveAirGap(settings.air_gap, process.env).enabled;
    const intel = await loadExploitIntel(cves, defaultIntelDeps(offline));
    const note = intel.kevChecked ? undefined : intel.notes.find((n) => n.includes("KEV"));
    return { kev: new Set(intel.kev.keys()), ...(note ? { note } : {}) };
  };
}

/** The lookup with env settings only, for callers that have no project config. */
export const defaultKevLookup: KevLookup = kevLookupFor({});

export async function gatherWatch(
  gh: GhRunner,
  now: () => number,
  kevLookup: KevLookup = defaultKevLookup,
): Promise<WatchCache> {
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
  const parsed = toAlerts(alerts);
  const cves = parsed.flatMap((a) => (a.cve ? [a.cve] : []));
  const { kev, note } = await kevLookup(cves);
  return {
    at,
    repo,
    ranked: rankSecurityPrs(prs.map(toOpenPr), parsed, kev),
    ...(note ? { kevNote: note } : {}),
  };
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
