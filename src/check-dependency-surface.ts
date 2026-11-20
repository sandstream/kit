/**
 * `kit check` and `kit review`: how much of the dependency tree is weight the project gets little
 * from. The measurement lives in dependency-surface.ts; this file reads the project and turns the
 * report into check rows.
 *
 * It never moves the verdict. Every row is `pass` (or `skip` when it cannot read the lockfile):
 * the findings are suggestions from a heuristic that reads imports, scripts and configs, not
 * proof that something is unneeded. A gate would need several real repositories without false
 * positives first.
 */
import { access, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import {
  analyseGraph,
  graphFromNpmLock,
  type DepGraph,
  type NpmLock,
  type ProjectManifest,
  type SurfaceFinding,
  type SurfaceReport,
} from "./dependency-surface.js";
import { graphFromPnpmLock, pnpmLockfileVersion } from "./dependency-surface-pnpm.js";
import { graphFromYarnLock } from "./dependency-surface-yarn.js";
import { scanSurfaceUsage } from "./dependency-surface-imports.js";
import {
  advisoriesPerDirect,
  type AdvisoryResult,
  type PackageRef,
} from "./dependency-surface-advisories.js";

/** Looks up known advisories for packages. Absent means the check does not ask. */
export type AdvisoryLookup = (packages: PackageRef[]) => Promise<AdvisoryResult>;

export interface SurfaceOptions {
  advisories?: AdvisoryLookup;
}

const NAME = "dependency surface";
const OTHER_LOCKFILES = ["bun.lock", "bun.lockb"];
const BLIND_SPOTS =
  "Reads imports, scripts and configs: dynamic imports, tools started from elsewhere and packages a framework loads by convention are not seen, so these are suggestions";

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

function skip(detail: string): SecurityCheckResult {
  return { category: "dependency", name: NAME, status: "skip", detail };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function summaryRow(
  report: SurfaceReport,
  source: string,
  scanned: { truncated: boolean; files: number; workspaceRoot: boolean },
): SecurityCheckResult {
  const t = report.totals;
  const heaviest = [...report.direct].sort((a, b) => b.brings - a.brings)[0];
  const parts = [
    `${t.direct} direct (${t.directProd} prod, ${t.directDev} dev)`,
    `${t.all} packages in ${source}: ${t.shipped} shipped, ${t.devOnly} development only`,
  ];
  if (heaviest && heaviest.brings > 0) {
    parts.push(
      `heaviest: ${heaviest.name} brings ${heaviest.brings}, ${heaviest.onlyThrough} only through it`,
    );
  }
  parts.push(
    report.findings.length === 0
      ? "nothing flagged"
      : `${new Set(report.findings.map((f) => f.rule)).size} thing(s) worth a look`,
  );
  const limit = scanned.truncated ? ` Scanned the first ${scanned.files} source files only.` : "";
  const unresolved =
    report.unresolvedDirect.length > 0
      ? ` Not found in ${source}: ${listedNames(report.unresolvedDirect, ", ")}.`
      : "";
  const workspace = scanned.workspaceRoot
    ? " This is a workspace root: the packages it names have their own dependencies, which are not counted as direct."
    : "";
  const missing =
    report.cannotSee.length > 0
      ? ` Not checked, because ${source} does not carry it: ${report.cannotSee.join(" and ")}.`
      : "";
  return {
    category: "dependency",
    name: NAME,
    status: "pass",
    detail: `${parts.join("; ")}. ${BLIND_SPOTS}.${limit}${missing}${unresolved}${workspace}`,
  };
}

const SHOWN = 5;

function listedNames(items: string[], sep: string): string {
  const shown = items.slice(0, SHOWN).join(sep);
  return items.length > SHOWN ? `${shown}${sep}+${items.length - SHOWN} more` : shown;
}

function groupDetail(rule: string, group: SurfaceFinding[]): string {
  if (rule === "unused") {
    return `${group.length} runtime ${group.length === 1 ? "dependency is" : "dependencies are"} imported nowhere and named in no script or config: ${listedNames(
      group.map((f) => f.subject),
      ", ",
    )}`;
  }
  if (rule === "dominant") {
    return `${group.length === 1 ? "a dependency takes" : `${group.length} dependencies take`} a large share of what ships: ${listedNames(
      group.map((f) => f.message),
      "; ",
    )}`;
  }
  if (rule === "heavy") {
    return `${group.length} ${group.length === 1 ? "dependency carries" : "dependencies carry"} most of the weight: ${listedNames(
      group.map((f) => f.message),
      "; ",
    )}`;
  }
  return group[0].message;
}

/** One row per rule: a project can have dozens of findings and the table must stay readable. */
function findingRows(findings: SurfaceFinding[]): SecurityCheckResult[] {
  const byRule = new Map<string, SurfaceFinding[]>();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  return [...byRule].map(([rule, group]) => ({
    category: "dependency" as const,
    name: `${NAME}: ${rule}`,
    status: "pass" as const,
    severity: "low" as const,
    detail: groupDetail(rule, group),
    suggestion: group[0].suggestion,
  }));
}

/**
 * The real lookup, unless `KIT_ADVISORIES=0`. A project in an air gap (config or `KIT_AIRGAP`) reads
 * only the cache; a config that cannot be read counts as an air gap, so nothing leaves by mistake.
 */
export async function advisoryOptionsFor(root: string): Promise<SurfaceOptions> {
  if (process.env.KIT_ADVISORIES === "0") return {};
  const { defaultAdvisoryDeps, loadAdvisories } =
    await import("./dependency-surface-advisories.js");
  let offline = true;
  try {
    const [{ loadConfig }, { resolveAirGap }] = await Promise.all([
      import("./config.js"),
      import("./airgap/config.js"),
    ]);
    offline = resolveAirGap((await loadConfig(join(root, ".kit.toml"))).air_gap).enabled;
  } catch {
    offline = true;
  }
  return { advisories: (packages) => loadAdvisories(packages, defaultAdvisoryDeps(offline)) };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * One row for the advisories OSV holds for the lockfile's packages, counted per direct dependency
 * so the heavy source of them is visible. Advisory only: it never moves the verdict. A lookup that
 * did not finish is a skip row, so a missing count is never read as a clean one.
 */
async function advisoryRow(
  graph: DepGraph,
  lookup: AdvisoryLookup,
): Promise<SecurityCheckResult | null> {
  let result: AdvisoryResult;
  try {
    const packages = [...graph.nodes.values()].map((n) => ({ name: n.name, version: n.version }));
    result = await lookup(packages);
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).replace(/[\x00-\x1f\x7f]/g, " ");
    result = { found: new Map(), checked: false, note: `lookup failed: ${why.slice(0, 160)}` };
  }
  const rows = advisoriesPerDirect(graph, result.found);
  const total = new Set(rows.flatMap((r) => r.ids)).size;
  if (!result.checked) {
    const partial =
      total > 0 ? ` ${plural(total, "advisory is", "advisories are")} known from the cache.` : "";
    return {
      category: "dependency",
      name: `${NAME}: advisories`,
      status: "skip",
      detail: `Advisories not checked: ${result.note ?? "the lookup did not finish"}.${partial}`,
    };
  }
  if (total === 0) return null;
  const listed = rows.map((r) => `${r.name}${r.dev ? " (dev)" : ""} (${r.ids.length})`);
  return {
    category: "dependency",
    name: `${NAME}: advisories`,
    status: "pass",
    severity: "low",
    detail: `${plural(total, "known advisory", "known advisories")} in ${plural(rows.length, "direct dependency", "direct dependencies")}; most through ${listedNames(listed, ", ")}`,
    suggestion:
      "Run `kit check --category security` for severity and fixes. Removing or replacing the dependency that brings the most clears the most.",
  };
}

/** The lockfile to read and the graph it gives, or the row that says why it could not be read. */
async function loadGraph(
  dir: string,
  manifest: ProjectManifest,
): Promise<{ graph: DepGraph; source: string } | SecurityCheckResult | null> {
  const lockPath = join(dir, "package-lock.json");
  if (await exists(lockPath)) {
    const lock = await readJson<NpmLock>(lockPath);
    if (!lock) return skip("package-lock.json could not be read");
    const graph = graphFromNpmLock(lock, manifest);
    if (!graph) {
      return skip(
        `lockfileVersion ${lock.lockfileVersion ?? "?"} has no package list; npm 7 or newer writes one`,
      );
    }
    return { graph, source: "package-lock.json" };
  }
  const yarnPath = join(dir, "yarn.lock");
  if (await exists(yarnPath)) {
    const text = await readFile(yarnPath, "utf8").catch(() => "");
    const graph = graphFromYarnLock(text, manifest);
    if (!graph)
      return skip("yarn.lock is neither the classic nor the berry format, so it was not read");
    return { graph, source: "yarn.lock" };
  }
  const pnpmPath = join(dir, "pnpm-lock.yaml");
  if (await exists(pnpmPath)) {
    const text = await readFile(pnpmPath, "utf8").catch(() => "");
    const graph = graphFromPnpmLock(text, manifest);
    if (!graph) {
      const format = pnpmLockfileVersion(text);
      return skip(
        format === null
          ? "pnpm-lock.yaml is not a pnpm lockfile, so it was not read"
          : `pnpm-lock.yaml is format ${format}; this analysis reads format 9 (pnpm 9 and newer), so it was not read`,
      );
    }
    return { graph, source: "pnpm-lock.yaml" };
  }
  for (const other of OTHER_LOCKFILES) {
    if (await exists(join(dir, other))) {
      return skip(
        `this analysis reads package-lock.json, yarn.lock and pnpm-lock.yaml; found ${other}, which is not read yet`,
      );
    }
  }
  return null;
}

/**
 * A lockfile that is missing most of the project's direct dependencies is out of date or belongs to
 * another project. Totals read from it would be wrong, so say that and measure nothing.
 */
function staleLockfile(
  report: SurfaceReport,
  manifest: ProjectManifest,
  source: string,
): SecurityCheckResult | null {
  const declared =
    Object.keys(manifest.dependencies ?? {}).length +
    Object.keys(manifest.devDependencies ?? {}).length;
  const missing = report.unresolvedDirect;
  if (missing.length < 3 || missing.length * 4 < declared) return null;
  return skip(
    `${missing.length} of ${declared} direct dependencies are not in ${source} (${listedNames(missing, ", ")}): it is out of date or belongs to another project, so nothing was measured`,
  );
}

const MAX_PARENTS = 5;

/** Ancestor folders that declare a workspace (a `workspaces` field or a lerna.json), nearest first. */
async function workspaceRoots(root: string): Promise<string[]> {
  const found: string[] = [];
  let dir = root;
  for (let i = 0; i < MAX_PARENTS; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const manifest = await readJson<ProjectManifest>(join(dir, "package.json"));
    if (
      manifest &&
      (manifest.workspaces !== undefined || (await exists(join(dir, "lerna.json"))))
    ) {
      found.push(dir);
    }
  }
  return found;
}

const posix = (p: string): string => p.split("\\").join("/");

export async function checkDependencySurface(
  root: string,
  options: SurfaceOptions = {},
): Promise<SecurityCheckResult[]> {
  const manifestPath = join(root, "package.json");
  if (!(await exists(manifestPath))) return [];
  const manifest = await readJson<ProjectManifest>(manifestPath);
  if (!manifest) return [skip("package.json could not be read")];

  // The project's own lockfile first. A member of a workspace often has none, or a stale leftover,
  // and the lockfile that governs it is the workspace root's.
  let failure: SecurityCheckResult | null = null;
  let usage: Awaited<ReturnType<typeof scanSurfaceUsage>> | null = null;
  for (const dir of [root, ...(await workspaceRoots(root))]) {
    const loaded = await loadGraph(dir, manifest);
    if (loaded === null) continue;
    if ("status" in loaded) {
      failure ??= loaded;
      continue;
    }
    usage ??= await scanSurfaceUsage(root, manifest);
    const report = analyseGraph({ graph: loaded.graph, manifest, usage });
    const source = dir === root ? loaded.source : `${posix(relative(root, dir))}/${loaded.source}`;
    const stale = staleLockfile(report, manifest, source);
    if (stale) {
      failure ??= stale;
      continue;
    }
    return [
      summaryRow(report, source, {
        truncated: usage.truncated,
        files: usage.filesScanned,
        workspaceRoot:
          manifest.workspaces !== undefined || (await exists(join(root, "lerna.json"))),
      }),
      ...findingRows(report.findings),
      ...(options.advisories ? [await advisoryRow(loaded.graph, options.advisories)] : []).filter(
        (r): r is SecurityCheckResult => r !== null,
      ),
    ];
  }
  return failure ? [failure] : [];
}
