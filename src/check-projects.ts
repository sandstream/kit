import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { findNestedProjects } from "./check-nested-projects.js";
import { resolveProjectPaths } from "./projects-config.js";

/**
 * Which checks a security run performs. `repo` is what belongs to the git root (history, ignore
 * rules, host, hooks), `project` is what belongs to one project directory (manifests, dependencies,
 * licences, infrastructure code), `all` is both, as before.
 */
export type SecurityLevel = "all" | "repo" | "project";

export type SecurityRunner = (dir: string, level: SecurityLevel) => Promise<SecurityCheckResult[]>;

const SCOPE = "scan scope";

function scopeRow(
  status: SecurityCheckResult["status"],
  detail: string,
  severity?: SecurityCheckResult["severity"],
): SecurityCheckResult {
  return { category: "supply-chain", name: SCOPE, status, detail, severity };
}

/** One row that says what the verdict covered, and what it did not. */
async function coverage(
  root: string,
  projects: string[],
  refused: { path: string; reason: string }[],
): Promise<SecurityCheckResult> {
  const unlisted = (await findNestedProjects(root)).filter(
    (n) => !projects.some((p) => n === p || n.startsWith(`${p}/`) || p.startsWith(`${n}/`)),
  );
  const problems: string[] = [];
  if (refused.length > 0) {
    problems.push(`refused: ${refused.map((r) => `${r.path} (${r.reason})`).join(", ")}`);
  }
  if (unlisted.length > 0) {
    problems.push(`not listed in [projects]: ${unlisted.slice(0, 5).join(", ")}`);
  }
  if (problems.length === 0) {
    return scopeRow(
      "pass",
      `repo level once in the root, ${projects.length} project(s): ${projects.join(", ")}`,
    );
  }
  const covered = projects.length > 0 ? ` Covered: ${projects.join(", ")}.` : "";
  return scopeRow("warn", `${problems.join("; ")}.${covered}`, "high");
}

/**
 * `kit check` for a repository that declares `[projects] paths`: the repo level runs once in the
 * root, the project level once per path, and one verdict comes out. A project row carries its path
 * in its name (`npm audit [backend]`), so the same check in two projects is two findings and one
 * run opens and closes only its own records. Project skips are dropped: a skip there only says a
 * tool has nothing to read, and the scope row already says what was covered.
 *
 * Without `[projects]` nothing changes: one run in the root, every check.
 */
export async function checkSecurityWithProjects(
  root: string,
  declared: string[] | undefined,
  run: SecurityRunner,
): Promise<SecurityCheckResult[]> {
  if (!declared || declared.length === 0) return run(root, "all");
  const { projects, refused } = resolveProjectPaths(root, declared);
  const rows = (await run(root, "repo")).filter((r) => r.name !== SCOPE);
  for (const p of projects) {
    for (const r of await run(join(root, p), "project")) {
      if (r.status !== "skip") rows.push({ ...r, name: `${r.name} [${p}]` });
    }
  }
  rows.push(await coverage(root, projects, refused));
  return rows;
}
