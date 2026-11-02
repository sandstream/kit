import type { ScannerDef } from "./scanners.js";

/**
 * Scanners that do not walk the tree themselves. Snyk fails in a repo root with no manifest ("No
 * supported files found"). trivy, grype and osv-scanner recurse, so they stay out: running them
 * per project would count each finding once per project.
 */
const PER_PROJECT_SCANNERS: ReadonlySet<string> = new Set(["snyk"]);

/**
 * Run each per-project scanner once in every declared project directory (`[projects] paths`).
 * Each run is named `<id>:<path>`, like the per-module SBOM runs, so a failure names its project.
 */
export function expandPerProject(
  scanners: readonly ScannerDef[],
  projects: readonly string[],
): ScannerDef[] {
  if (projects.length === 0) return [...scanners];
  return scanners.flatMap((s) =>
    PER_PROJECT_SCANNERS.has(s.id) && s.cwd === undefined
      ? projects.map((dir) => ({ ...s, id: `${s.id}:${dir}`, cwd: dir }))
      : [s],
  );
}
