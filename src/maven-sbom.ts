import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { getCurrentProjectRoot, resolveLocalProjectPath } from "./memory/project.js";
import { SCANNERS, isScannerEnabled, type ScannerDef } from "./scanners.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";

const MAX_DEPTH = 3;
const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", "vendor", ".m2"]);
const COMMAND = "mvn org.cyclonedx:cyclonedx-maven-plugin:makeAggregateBom";

interface MavenProject {
  dir: string;
  bom?: string;
}

function safeBom(root: string, relativePath: string): boolean {
  let fd: number | undefined;
  try {
    const absolute = join(root, relativePath);
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(absolute, flags);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return false;
    const resolved = realpathSync(absolute);
    const within = relative(realpathSync(root), resolved);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return false;
    if (!sameIdentity(opened, identityOf(resolved))) return false;
    const bom = JSON.parse(readFileSync(fd, "utf8"));
    return bom?.bomFormat === "CycloneDX" && typeof bom.specVersion === "string";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
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

/** Only unconditional project/modules/module entries are in the Maven reactor. */
function declaredModules(root: string, dir: string): string[] {
  let xml: string;
  try {
    xml = readFileSync(join(root, dir, "pom.xml"), "utf8");
  } catch {
    return [];
  }
  // \x3c is "<"; it avoids a Semgrep parser error on HTML comment regexes.
  const tokens = xml.match(/\x3c!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  const stack: string[] = [];
  const modules: string[] = [];
  let value = "";
  for (const token of tokens) {
    if (token.startsWith("<!--")) continue;
    if (!token.startsWith("<")) {
      if (stack.join("/") === "project/modules/module") value += token;
      continue;
    }
    const tag = token.match(/^<\/?\s*([A-Za-z_][\w:.-]*)/);
    if (!tag) continue;
    const name = tag[1].split(":").at(-1)!;
    if (token.startsWith("</")) {
      if (stack.join("/") === "project/modules/module" && name === "module" && value.trim()) {
        modules.push(value.trim());
      }
      value = "";
      if (stack.at(-1) === name) stack.pop();
      else stack.length = 0;
    } else if (!/\/\s*>$/.test(token)) {
      stack.push(name);
    }
  }
  return modules;
}

function bomSources(root: string, projects: MavenProject[]): Map<string, string> {
  const byDir = new Map(projects.map((project) => [project.dir, project]));
  const sources = new Map<string, string>();
  const visit = (project: MavenProject, bom: string): void => {
    if (sources.has(project.dir)) return;
    sources.set(project.dir, bom);
    for (const module of declaredModules(root, project.dir)) {
      if (isAbsolute(module)) continue;
      const path = relative(root, resolve(root, project.dir, module));
      if (path === ".." || path.startsWith(".." + sep)) continue;
      const child = byDir.get(path.replaceAll(sep, "/") || ".");
      if (child) visit(child, bom);
    }
  };
  for (const project of projects) {
    if (project.bom) visit(project, project.bom);
  }
  return sources;
}

function ancestorSources(
  root: string,
  projects: MavenProject[],
  localSources: Map<string, string>,
): Map<string, string> {
  const found = new Map<string, string>();
  if (localSources.size === projects.length) return found;
  let prefix: string;
  try {
    prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replaceAll("\\", "/")
      .replace(/\/+$/, "");
  } catch {
    return found;
  }
  if (!prefix) return found;
  const repoRoot = resolveLocalProjectPath(getCurrentProjectRoot(root));
  const repoSources = bomSources(repoRoot, mavenProjects(repoRoot));
  for (const project of projects) {
    if (localSources.has(project.dir)) continue;
    const path = project.dir === "." ? prefix : prefix + "/" + project.dir;
    const source = repoSources.get(path);
    if (source) found.set(project.dir, join(repoRoot, source));
  }
  return found;
}

/** State the missing transitive input. Presence is not a vulnerability verdict. */
export async function checkMavenSbomCoverage(root: string): Promise<SecurityCheckResult> {
  const projects = mavenProjects(root);
  const name = "Maven SBOM input";
  if (projects.length === 0) {
    return { category: "supply-chain", name, status: "skip", detail: "no pom.xml found" };
  }
  const localSources = bomSources(root, projects);
  const inheritedSources = ancestorSources(root, projects, localSources);
  const missing = projects.filter((p) => !localSources.has(p.dir) && !inheritedSources.has(p.dir));
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
  const bomInputs = new Set([
    ...projects.flatMap((p) => (p.bom ? [p.bom] : [])),
    ...inheritedSources.values(),
  ]);
  return {
    category: "supply-chain",
    name,
    status: "pass",
    detail: `${bomInputs.size} CycloneDX BOM input(s) cover ${projects.length} Maven project(s) for osv-scanner and grype in kit scan`,
  };
}

/** Give both scanners the BOM path explicitly because target/ is usually gitignored. */
export function mavenSbomScanners(root: string, delegates?: readonly string[]): ScannerDef[] {
  const result: ScannerDef[] = [];
  const projects = mavenProjects(root);
  const localSources = bomSources(root, projects);
  const inheritedSources = ancestorSources(root, projects, localSources);
  const inputs = [
    ...projects.flatMap((project) => (project.bom ? [{ dir: project.dir, bom: project.bom }] : [])),
    ...[...inheritedSources].map(([dir, bom]) => ({ dir, bom })),
  ];
  const seen = new Set<string>();
  for (const project of inputs) {
    if (seen.has(project.bom)) continue;
    seen.add(project.bom);
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
