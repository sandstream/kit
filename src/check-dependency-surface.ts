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
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import {
  analyseSurface,
  type NpmLock,
  type ProjectManifest,
  type SurfaceFinding,
  type SurfaceReport,
} from "./dependency-surface.js";
import { scanSurfaceUsage } from "./dependency-surface-imports.js";

const NAME = "dependency surface";
const OTHER_LOCKFILES = ["yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];
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
  scanned: { truncated: boolean; files: number },
): SecurityCheckResult {
  const t = report.totals;
  const heaviest = [...report.direct].sort((a, b) => b.brings - a.brings)[0];
  const parts = [
    `${t.direct} direct (${t.directProd} prod, ${t.directDev} dev)`,
    `${t.all} packages in the lockfile: ${t.shipped} shipped, ${t.devOnly} development only`,
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
  return {
    category: "dependency",
    name: NAME,
    status: "pass",
    detail: `${parts.join("; ")}. ${BLIND_SPOTS}.${limit}`,
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

export async function checkDependencySurface(root: string): Promise<SecurityCheckResult[]> {
  const manifestPath = join(root, "package.json");
  if (!(await exists(manifestPath))) return [];

  const lockPath = join(root, "package-lock.json");
  if (!(await exists(lockPath))) {
    for (const other of OTHER_LOCKFILES) {
      if (await exists(join(root, other))) {
        return [
          skip(`this analysis reads package-lock.json only; found ${other}, which is not read yet`),
        ];
      }
    }
    return [];
  }

  const manifest = await readJson<ProjectManifest>(manifestPath);
  const lock = await readJson<NpmLock>(lockPath);
  if (!manifest || !lock) return [skip("package.json or package-lock.json could not be read")];

  const usage = await scanSurfaceUsage(root, manifest);
  const report = analyseSurface({ lock, manifest, usage });
  if (!report) {
    return [
      skip(
        `lockfileVersion ${lock.lockfileVersion ?? "?"} has no package list; npm 7 or newer writes one`,
      ),
    ];
  }
  return [
    summaryRow(report, { truncated: usage.truncated, files: usage.filesScanned }),
    ...findingRows(report.findings),
  ];
}
