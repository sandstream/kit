import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { findNestedProjects, scanScopeFacts } from "./check-nested-projects.js";
import { findIac } from "./check-iac-detect.js";
import type { kitConfig } from "./config.js";
import { resolveProjectPaths } from "./projects-config.js";

/**
 * Which checks a security run performs. `repo` is what belongs to the git root (history, ignore
 * rules, host, hooks), `project` is what belongs to one project directory (manifests, dependencies,
 * licences, infrastructure code), `all` is both, as before.
 */
export type SecurityLevel = "all" | "repo" | "project";

export type SecurityRunner = (dir: string, level: SecurityLevel) => Promise<SecurityCheckResult[]>;

/** Project-level checks that need the governed config, not only a directory (browser bundles). */
export type ProjectExtras = (dir: string) => Promise<SecurityCheckResult[]>;

/** The client-exposure checks, run per project with the root's allow list and declared key names. */
export function clientExposureExtras(config: kitConfig): ProjectExtras {
  return async (dir) => {
    const { checkClientExposedNames, checkBuiltBundleSecrets } =
      await import("./check-client-exposure.js");
    const allow: Record<string, string> = config.scan?.client_exposed_allow ?? {};
    const names = Object.keys(config.secrets?.keys ?? {});
    return [await checkClientExposedNames(dir, allow, names), await checkBuiltBundleSecrets(dir)];
  };
}

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
  rootIsProject: boolean,
  incomplete: string[],
): Promise<SecurityCheckResult> {
  const nested = new Set(await findNestedProjects(root));
  for (const p of projects) {
    for (const child of await findNestedProjects(join(root, p))) nested.add(`${p}/${child}`);
  }
  // A manifest scan at a parent path does not necessarily read a child manifest.
  const unlisted = [...nested].filter((n) => !projects.includes(n)).sort();
  const problems: string[] = [];
  if (refused.length > 0) {
    problems.push(`refused: ${refused.map((r) => `${r.path} (${r.reason})`).join(", ")}`);
  }
  if (unlisted.length > 0) {
    problems.push(`not listed in [projects]: ${unlisted.slice(0, 5).join(", ")}`);
  }
  if (incomplete.length > 0) {
    problems.push(`not fully scanned: ${incomplete.join(", ")}`);
  }
  if (problems.length === 0) {
    return scopeRow(
      "pass",
      `repo level once in the root${rootIsProject ? ", root project checks" : ""}, ${projects.length} project(s): ${projects.join(", ")}`,
    );
  }
  const coveredProjects = projects.filter((p) => !incomplete.includes(p));
  const covered = coveredProjects.length > 0 ? ` Covered: ${coveredProjects.join(", ")}.` : "";
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
  extras: ProjectExtras = async () => [],
): Promise<SecurityCheckResult[]> {
  if (!declared || declared.length === 0) return run(root, "all");
  const { projects, refused } = resolveProjectPaths(root, declared);
  const rows = (await run(root, "repo")).filter((r) => r.name !== SCOPE);
  // A root with a manifest or infrastructure code of its own is a project too, and keeps its names.
  const rootScope = await scanScopeFacts(root);
  const iac = await findIac(root);
  const rootIsProject =
    rootScope.rootManifest ||
    iac.some((dir) => dir === "." || !projects.some((p) => dir === p || dir.startsWith(`${p}/`)));
  // The repo-level scan already runs client exposure checks in the root.
  if (rootIsProject) rows.push(...(await projectRows(root, "", run, async () => [])));
  const incomplete: string[] = [];
  for (const p of projects) {
    const dir = join(root, p);
    const found = await projectRows(dir, p, run, extras);
    const hasManifest = (await scanScopeFacts(dir)).rootManifest;
    const hasIac = (await findIac(dir)).length > 0;
    if (found.length === 0 || (!hasManifest && !hasIac)) incomplete.push(p);
    if (found.length === 0) {
      rows.push({
        category: "supply-chain",
        name: `nothing scanned [${p}]`,
        status: "warn",
        severity: "high",
        detail: `every project check skipped in ${p}; inspect the scanner inputs and configuration`,
      });
    } else if (!hasManifest && !hasIac) {
      rows.push({
        category: "supply-chain",
        name: `manifest scope [${p}]`,
        status: "warn",
        severity: "high",
        detail: `no manifest or infrastructure code found in ${p}; manifest-dependent checks did not cover a project there`,
      });
    }
    rows.push(...found);
  }
  rows.push(await coverage(root, projects, refused, rootIsProject, incomplete));
  return rows;
}

/** The rows of one project, skips dropped. A named project suffixes each row with its path. */
async function projectRows(
  dir: string,
  path: string,
  run: SecurityRunner,
  extras: ProjectExtras,
): Promise<SecurityCheckResult[]> {
  const all = [...(await run(dir, "project")), ...(await extras(dir))];
  return all
    .filter((r) => r.status !== "skip")
    .map((r) => (path ? { ...r, name: `${r.name} [${path}]` } : r));
}
