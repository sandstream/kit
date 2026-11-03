/**
 * `kit watch` (zero-trust plan Z4): `run` ranks open security PRs and caches the result
 * for the status line, `install` writes the daily scheduler entry, `status` prints the
 * cached segment. Reads GitHub through `gh`; opens PAL items locally, never writes to
 * GitHub.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { c } from "../utils/colors.js";
import { writeFileExclusiveSync } from "../utils/exclusive-file.js";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import { flagValue, hasFlag } from "../utils/flags.js";
import { isReadOnlyMode } from "../read-only-mode.js";
import {
  WATCH_CACHE,
  cronLine,
  gatherWatch,
  launchdPlist,
  palTitlesFor,
  readWatchCache,
  watchSegment,
  watchWorkflow,
  type WatchCache,
} from "../watch.js";

export async function cmdWatch(): Promise<boolean> {
  const sub = process.argv[3];
  if (sub === "run") return cmdWatchRun();
  if (sub === "install") return cmdWatchInstall();
  if (sub === "status") return cmdWatchStatus();
  console.error(`${c.red}usage: kit watch <run|install|status> [--json]${c.reset}`);
  process.exitCode = 1;
  return false;
}

async function openPalTitles(): Promise<string[]> {
  const { openMemoryDbReadOnly, getMemoryDbPath } = await import("../memory/db.js");
  const { palList } = await import("../memory/pal.js");
  const { getCurrentProjectRoot } = await import("../memory/project.js");
  if (!existsSync(getMemoryDbPath())) return [];
  const db = openMemoryDbReadOnly();
  try {
    return palList(db, { scope: getCurrentProjectRoot(), readOnly: true }).map((a) => a.title);
  } finally {
    db.close();
  }
}

async function openPalItems(titles: string[]): Promise<string[]> {
  const { openMemoryDb } = await import("../memory/db.js");
  const { palAdd } = await import("../memory/pal.js");
  const { getCurrentProjectRoot } = await import("../memory/project.js");
  const db = openMemoryDb();
  try {
    return titles.map((title) => palAdd(db, { title, scope: getCurrentProjectRoot() }));
  } finally {
    db.close();
  }
}

function writeCache(cache: WatchCache): void {
  const path = resolve(process.cwd(), WATCH_CACHE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2) + "\n");
}

async function cmdWatchRun(): Promise<boolean> {
  const gh = async (args: string[]) => {
    const r = await execFileNoThrow("gh", args, { timeout: 30_000 });
    return { ok: r.ok, stdout: r.stdout };
  };
  const cache = await gatherWatch(gh, Date.now);
  const readOnly = isReadOnlyMode();
  if (!readOnly) writeCache(cache);
  let opened: string[] = [];
  if (!readOnly && !hasFlag(process.argv, "--no-pal") && !cache.unverified) {
    opened = await openPalItems(palTitlesFor(cache.ranked, await openPalTitles()));
  }
  if (hasFlag(process.argv, "--json")) {
    console.log(JSON.stringify({ ...cache, palOpened: opened.length }, null, 2));
    return true;
  }
  console.log(`${c.bold}kit watch${c.reset}  ${c.dim}${cache.repo || "no repository"}${c.reset}`);
  if (cache.unverified) console.log(`  ${c.yellow}unverified: ${cache.unverified}${c.reset}`);
  else if (cache.ranked.length === 0) console.log(`  ${c.dim}no open security PRs${c.reset}`);
  for (const pr of cache.ranked) {
    console.log(`  ${c.bold}#${pr.number}${c.reset} ${pr.severity} ci:${pr.ci}  ${pr.title}`);
  }
  if (opened.length > 0)
    console.log(`  ${c.green}✓${c.reset} opened ${opened.length} action item(s)`);
  return true;
}

function cmdWatchStatus(): boolean {
  const line = watchSegment(readWatchCache(process.cwd()), Date.now());
  if (hasFlag(process.argv, "--json")) console.log(JSON.stringify({ line }));
  else if (line) console.log(line);
  return true;
}

function intFlag(name: string, fallback: number, max: number): number | null {
  const raw = flagValue(process.argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

function writeEntry(dest: string, body: string): boolean {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    if (hasFlag(process.argv, "--force")) writeFileSync(dest, body);
    else writeFileExclusiveSync(dest, body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    console.error(`${c.yellow}${dest} exists, re-run with --force to overwrite${c.reset}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/** `kit watch install [--target launchd|cron|workflow] [--hour H] [--minute M] [--force]`. */
async function cmdWatchInstall(): Promise<boolean> {
  const target =
    flagValue(process.argv, "--target") ?? (process.platform === "darwin" ? "launchd" : "cron");
  const hour = intFlag("--hour", 7, 23);
  const minute = intFlag("--minute", 15, 59);
  if (hour === null || minute === null || !["launchd", "cron", "workflow"].includes(target)) {
    console.error(
      `${c.red}usage: kit watch install [--target launchd|cron|workflow] [--hour 0-23] [--minute 0-59] [--force]${c.reset}`,
    );
    process.exitCode = 1;
    return false;
  }
  const cwd = process.cwd();
  // Node plus the script that is running now, so the entry needs no PATH lookup or exec bit.
  const command = [process.execPath, ...(process.argv[1] ? [process.argv[1]] : [])];
  if (target === "cron") {
    console.log(cronLine({ command, cwd, hour, minute }));
    console.log(
      `${c.dim}add this line with \`crontab -e\`; kit does not edit your crontab${c.reset}`,
    );
    return true;
  }
  if (target === "workflow") {
    const dest = resolve(cwd, ".github/workflows/kit-watch.yml");
    if (!writeEntry(dest, watchWorkflow(`${minute} ${hour} * * *`))) return false;
    console.log(`${c.green}✓${c.reset} wrote .github/workflows/kit-watch.yml`);
    console.log(
      `  ${c.dim}the workflow token cannot read Dependabot alerts, so the ranking there reads unverified; use launchd or cron for the ranked list${c.reset}`,
    );
    return true;
  }
  const label = `com.sandstream.kit-watch.${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
  const dest = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
  const logPath = resolve(cwd, ".kit/watch.log");
  if (!writeEntry(dest, launchdPlist({ label, command, cwd, hour, minute, logPath }))) return false;
  console.log(`${c.green}✓${c.reset} wrote ${dest}`);
  console.log(`  load it once:   launchctl bootstrap gui/$(id -u) ${dest}`);
  console.log(`  remove it:      launchctl bootout gui/$(id -u) ${dest} && rm ${dest}`);
  return true;
}
