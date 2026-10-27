import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { SCANNERS, isScannerEnabled, type ScannerDef } from "./scanners.js";

const MAX_DEPTH = 3;
const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", "vendor", ".m2"]);
const COMMAND = "mvn org.cyclonedx:cyclonedx-maven-plugin:makeAggregateBom";

interface MavenProject {
  dir: string;
  bom?: string;
}

function safeBom(root: string, relativePath: string): boolean {
  try {
    const absolute = join(root, relativePath);
    if (!lstatSync(absolute).isFile()) return false;
    const within = relative(realpathSync(root), realpathSync(absolute));
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return false;
    const bom = JSON.parse(readFileSync(absolute, "utf8"));
    return bom?.bomFormat === "CycloneDX" && typeof bom.specVersion === "string";
  } catch {
    return false;
  }
}

/** Find Maven roots and generated aggregate BOMs without descending into build output. */
function mavenProjects(root: string): MavenProject[] {
  const found: MavenProject[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "pom.xml")) {
      const bom = rel ? `${rel}/target/bom.json` : "target/bom.json";
      found.push({ dir: rel || ".", ...(safeBom(root, bom) ? { bom } : {}) });
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP.has(entry.name)) {
        walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
      }
    }
  };
  walk(root, "", 0);
  return found;
}

/** State the missing transitive input. Presence is not a vulnerability verdict. */
export async function checkMavenSbomCoverage(root: string): Promise<SecurityCheckResult> {
  const projects = mavenProjects(root);
  const name = "Maven SBOM input";
  if (projects.length === 0) {
    return { category: "supply-chain", name, status: "skip", detail: "no pom.xml found" };
  }
  const missing = projects.filter((p) => !p.bom);
  if (missing.length > 0) {
    const projectWord = missing.length === 1 ? "project" : "projects";
    const firstDirectory = missing[0].dir === "." ? "this directory" : missing[0].dir;
    return {
      category: "supply-chain",
      name,
      status: "warn",
      severity: "high",
      didNotRun: true,
      detail: `pom.xml lists direct dependencies only. ${missing.length} Maven ${projectWord} lack a valid CycloneDX target/bom.json: ${missing.map((p) => p.dir).join(", ")}. Run ${COMMAND} in each listed directory, then run kit scan.`,
      suggestion: `Run ${COMMAND} in ${firstDirectory}. Then run kit scan to check the generated SBOM.`,
    };
  }
  return {
    category: "supply-chain",
    name,
    status: "pass",
    detail: `${projects.length} CycloneDX BOM input(s) available for osv-scanner and grype in kit scan`,
  };
}

/** Give both scanners the BOM path explicitly because target/ is usually gitignored. */
export function mavenSbomScanners(root: string, delegates?: readonly string[]): ScannerDef[] {
  const result: ScannerDef[] = [];
  for (const project of mavenProjects(root)) {
    if (!project.bom) continue;
    const grype = SCANNERS.find((s) => s.id === "grype");
    if (grype && isScannerEnabled("grype", delegates)) {
      result.push({
        ...grype,
        id: `grype-sbom:${project.dir}`,
        args: [`sbom:${project.bom}`, "-o", "sarif", "-q"],
      });
    }
    const osv = SCANNERS.find((s) => s.id === "osv-scanner");
    if (osv && isScannerEnabled("osv-scanner", delegates)) {
      result.push({
        ...osv,
        id: `osv-scanner-sbom:${project.dir}`,
        args: ["scan", "source", "--format", "json", "-L", project.bom],
      });
    }
  }
  return result;
}
