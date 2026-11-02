/**
 * Which findings are in what is deployed, and which only on the branch (Z4 part 2).
 *
 * The deployed commit comes from `[deploy.health]` (deploy-health.ts). This module reads
 * `package-lock.json` as it was at that commit with `git show`, never from the working tree,
 * and tags each dependency finding `deployed` or `branch only`. It tags; it does not change a
 * row's status or severity. When the deployed state cannot be read, the row says unverified
 * with the reason. It does not guess.
 *
 * Scope: npm `package-lock.json` (lockfileVersion 2 or 3) only. Other lockfiles are unverified.
 */
import { deployedCommit } from "./check-deploy.js";
import type { SecurityCheckResult } from "./check-security.js";
import type { kitConfig } from "./config.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

export type LockedPackages =
  { ok: true; commit: string; packages: Set<string> } | { ok: false; reason: string };

const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const MAX_LOCK_BYTES = 32 * 1024 * 1024;
const NODE_MODULES = "node_modules/";
const LISTED = 10;

/** `node_modules/a/node_modules/@s/b` -> `@s/b`. The root entry ("") has no name. */
function nameOfPath(path: string): string | null {
  const at = path.lastIndexOf(NODE_MODULES);
  return at === -1 ? null : path.slice(at + NODE_MODULES.length) || null;
}

export async function lockedPackagesAt(cwd: string, commit: string): Promise<LockedPackages> {
  if (!COMMIT_RE.test(commit))
    return { ok: false, reason: "the deployed value is not a commit hash" };
  const has = await execFileNoThrow("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd });
  if (!has.ok) return { ok: false, reason: "the commit is not in this clone, fetch it first" };
  const shown = await execFileNoThrow("git", ["show", `${commit}:./package-lock.json`], {
    cwd,
    maxBuffer: MAX_LOCK_BYTES,
  });
  if (!shown.ok || shown.truncated) {
    return { ok: false, reason: "package-lock.json is missing or too large at that commit" };
  }
  let parsed: { packages?: Record<string, { version?: unknown }> };
  try {
    parsed = JSON.parse(shown.stdout);
  } catch {
    return { ok: false, reason: "package-lock.json at that commit is not valid JSON" };
  }
  if (!parsed.packages || typeof parsed.packages !== "object") {
    return {
      ok: false,
      reason: "package-lock.json at that commit has no packages map (lockfileVersion 1)",
    };
  }
  const packages = new Set<string>();
  for (const [path, entry] of Object.entries(parsed.packages)) {
    const name = nameOfPath(path);
    if (name && typeof entry?.version === "string") packages.add(`${name}@${entry.version}`);
  }
  return { ok: true, commit, packages };
}

function list(items: string[]): string {
  const more = items.length > LISTED ? ` +${items.length - LISTED} more` : "";
  return `${items.slice(0, LISTED).join(", ")}${more}`;
}

function tagOne(row: SecurityCheckResult, deployed: LockedPackages): SecurityCheckResult {
  if (!row.affected || row.affected.length === 0) return row;
  if (!deployed.ok) {
    return { ...row, detail: `${row.detail} | deployed: unverified (${deployed.reason})` };
  }
  const inDeployed: string[] = [];
  const branchOnly: string[] = [];
  for (const p of row.affected) {
    const label = `${p.name} ${p.version}`;
    (deployed.packages.has(`${p.name}@${p.version}`) ? inDeployed : branchOnly).push(label);
  }
  const short = deployed.commit.slice(0, 7);
  const parts = [`deployed (${short}): ${inDeployed.length ? list(inDeployed) : "none"}`];
  if (branchOnly.length) parts.push(`branch only: ${list(branchOnly)}`);
  return { ...row, detail: `${row.detail} | ${parts.join("; ")}` };
}

export function tagDeployed(
  rows: SecurityCheckResult[],
  deployed: LockedPackages,
): SecurityCheckResult[] {
  return rows.map((row) => tagOne(row, deployed));
}

export interface TagOptions {
  /** Tests only: allow http to the literal loopback address for the health URL. */
  allowLoopback?: boolean;
  /** Tests only: override the air-gap posture that is otherwise read from the project's config. */
  airGap?: boolean;
}

/**
 * The run-level step: tag the dependency rows against the deployed lockfile. Only with
 * `--online` and a `[deploy.health]` table. A project with `[projects]` paths is not
 * tagged yet, because each subproject has its own lockfile.
 */
export async function tagWithDeployed(
  rows: SecurityCheckResult[],
  config: kitConfig,
  cwd: string,
  online: boolean | undefined,
  opts: TagOptions = {},
): Promise<SecurityCheckResult[]> {
  if (!online || !(config.deploy as { health?: unknown } | undefined)?.health) return rows;
  if (config.projects?.paths?.length) {
    return tagDeployed(rows, { ok: false, reason: "not supported together with [projects] yet" });
  }
  const commit = await deployedCommit(config.deploy, cwd, { online: true, ...opts });
  const locked: LockedPackages = commit
    ? await lockedPackagesAt(cwd, commit)
    : { ok: false, reason: "the deployed commit was not read, see the deploy rows" };
  return tagDeployed(rows, locked);
}
