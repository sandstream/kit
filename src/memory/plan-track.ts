/** Local plan discovery for PAL. The scan reads a fixed set of directories and never follows links. */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  constants,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { deviceId, palSyncFindings, type SyncFinding, type SyncFindingsResult } from "./pal.js";

const MAX_PLAN_BYTES = 256 * 1024;
const PLAN_NAME = /^(?:plan|[a-z0-9][a-z0-9_.-]*[-_]plan(?:[-_.][a-z0-9_.-]*)?)\.md$/i;
const COMPLETE = /^(?:complete|completed|done|closed|built|shipped)\.?$/i;

export interface PlanFile {
  path: string;
  name: string;
  state: "open" | "unknown" | "complete";
}

export interface PlanScan {
  plans: PlanFile[];
  issues: string[];
}

function projectName(root: string): string {
  try {
    const remote = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    const name = basename(remote.replace(/\.git$/i, ""));
    if (/^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(name)) return name;
  } catch {
    // A local directory name still gives a bounded adjacent-file match.
  }
  return basename(root);
}

function readPlan(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PLAN_BYTES)
      throw new Error("not a regular file or over 256 KiB");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function planState(source: string): PlanFile["state"] {
  const firstLines = source.split(/\r?\n/, 30);
  const status = firstLines.find((line) => /^\s*Status\s*:/i.test(line));
  if (!status) return "unknown";
  if (/^\s*[-*]\s*\[\s\]/m.test(source)) return "open";
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!;
    if (!/^\|\s*Phase\s*\|\s*Status\s*\|/i.test(header)) continue;
    for (let row = i + 1; row < lines.length && /^\|/.test(lines[row]!); row++) {
      const phaseStatus = lines[row]!.split("|")[2]?.trim() ?? "";
      if (/^(?:pending|later|blocked|partial|not started|in progress)\b/i.test(phaseStatus))
        return "open";
    }
  }
  return COMPLETE.test(status.replace(/^\s*Status\s*:\s*/i, "")) ? "complete" : "open";
}

/** Inspect only root, common plan directories, and matching files beside the repository. */
export function scanPlanFiles(root: string): PlanScan {
  const plans: PlanFile[] = [];
  const issues: string[] = [];
  const parent = dirname(root);
  const prefix = `${projectName(root)}-`.toLowerCase();
  const directories = [
    root,
    join(root, "plans"),
    join(root, "docs", "plans"),
    join(root, ".kit", "plans"),
    join(root, ".claude", "plans"),
    parent,
  ];
  for (const directory of directories) {
    let entries;
    try {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink()) {
        issues.push(`${directory}: symlink directory`);
        continue;
      }
      if (!stat.isDirectory()) {
        issues.push(`${directory}: not a directory`);
        continue;
      }
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        issues.push(`${directory}: cannot list directory`);
      continue;
    }
    for (const entry of entries) {
      if (!PLAN_NAME.test(entry.name)) continue;
      if (directory === parent && !entry.name.toLowerCase().startsWith(prefix)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push(`${path}: symlink plan`);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        plans.push({ path, name: entry.name, state: planState(readPlan(path)) });
      } catch {
        issues.push(`${path}: cannot read plan`);
      }
    }
  }
  plans.sort((a, b) => a.path.localeCompare(b.path));
  return { plans, issues };
}

interface PlanDetail {
  path: string;
  state: "open" | "unknown" | "source missing";
}

function finding(path: string, state: PlanDetail["state"]): SyncFinding {
  return {
    dedupKey: path,
    title: `${state === "unknown" ? "Plan status unclear" : "Plan incomplete"}: ${basename(path)}`,
    detail: JSON.stringify({ path, state } satisfies PlanDetail),
  };
}

export interface PlanSync extends SyncFindingsResult {
  found: number;
  pending: string[];
  issues: string[];
}

/** Reconcile explicit completion only. A missing or unreadable source stays pending. */
export function syncPlanFiles(db: DatabaseSync, root: string): PlanSync {
  const scan = scanPlanFiles(root);
  const pending = scan.plans.filter((p) => p.state !== "complete").map((p) => p.name);
  if (scan.issues.length)
    return {
      added: 0,
      reopened: 0,
      closed: [],
      found: scan.plans.length,
      pending,
      issues: scan.issues,
    };
  const seen = new Set(scan.plans.map((p) => p.path));
  const findings = scan.plans
    .filter((p) => p.state !== "complete")
    .map((p) => finding(p.path, p.state === "unknown" ? "unknown" : "open"));
  const existing = db
    .prepare(
      "SELECT detail FROM pending_actions WHERE kind='finding' AND id LIKE 'plan-%' AND scope IS ? AND origin_device = ? AND status IN ('open','claimed','snoozed')",
    )
    .all(root, deviceId()) as { detail: string | null }[];
  for (const row of existing) {
    let detail: PlanDetail;
    try {
      detail = JSON.parse(row.detail ?? "") as PlanDetail;
      if (typeof detail.path !== "string") throw new Error("missing path");
    } catch {
      return {
        added: 0,
        reopened: 0,
        closed: [],
        found: scan.plans.length,
        pending,
        issues: ["Existing plan item has unreadable provenance"],
      };
    }
    if (!seen.has(detail.path)) findings.push(finding(detail.path, "source missing"));
  }
  return {
    ...palSyncFindings(db, "plan", findings, { scope: root }),
    found: scan.plans.length,
    pending,
    issues: [],
  };
}
