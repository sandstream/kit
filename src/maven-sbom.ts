import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { scannerObject, type ScannerReportGap } from "./check-scanner-evidence.js";
import { sanitizeDisplayText } from "./display-text.js";
import { getCurrentProjectRoot, resolveLocalProjectPath } from "./memory/project.js";
import { SCANNERS, isScannerEnabled, type ScannerDef } from "./scanners.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";

const MAX_DEPTH = 3;
const MAX_POM_BYTES = 4 * 1024 * 1024;
const MAX_BOM_BYTES = 64 * 1024 * 1024;
const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", "vendor", ".m2"]);
const COMMAND = "mvn org.cyclonedx:cyclonedx-maven-plugin:makeAggregateBom";

interface MavenGap {
  target: string;
  evidenceStatus: ScannerReportGap | "stale";
  reason: string;
}

interface MavenProject {
  dir: string;
  bom: string;
  bomGap?: MavenGap;
  modules: string[];
}

interface MavenDiscovery {
  projects: MavenProject[];
  gaps: MavenGap[];
}

type MavenRead = { text: string } | Omit<MavenGap, "target">;

function outsideRoot(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function readOpenedFile(fd: number, path: string, root: string, maxBytes: number): MavenRead {
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile()) {
    return { evidenceStatus: "unsupported", reason: "must be a regular file." };
  }
  const resolved = realpathSync(path);
  if (outsideRoot(relative(root, resolved)) || !sameIdentity(before, identityOf(resolved))) {
    return { evidenceStatus: "unsupported", reason: "could not be bound to the project." };
  }
  if (before.size > BigInt(maxBytes)) {
    return { evidenceStatus: "partial", reason: "exceeds the Maven input size limit." };
  }
  const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  const after = lstatSync(path, { bigint: true });
  if (
    offset !== Number(before.size) ||
    !after.isFile() ||
    !sameIdentity(before, after) ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    return { evidenceStatus: "partial", reason: "changed during Maven input discovery." };
  }
  const contents = bytes.subarray(0, offset);
  if (!isUtf8(contents)) {
    return { evidenceStatus: "malformed", reason: "is not valid UTF-8." };
  }
  return { text: contents.toString("utf8") };
}

function readMavenFile(root: string, target: string, maxBytes: number): MavenRead {
  const path = join(root, target);
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile() || outsideRoot(relative(root, realpathSync(path)))) {
      return {
        evidenceStatus: "unsupported",
        reason: "must be a regular file inside the project.",
      };
    }
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(path, flags);
    return readOpenedFile(fd, path, root, maxBytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && fd === undefined) {
      return { evidenceStatus: "missing", reason: "is missing." };
    }
    return { evidenceStatus: "unavailable", reason: "could not be read." };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function inspectBom(root: string, dir: string, path: string): MavenGap | undefined {
  const file = readMavenFile(root, path, MAX_BOM_BYTES);
  if (!("text" in file)) {
    return {
      target: dir,
      evidenceStatus: file.evidenceStatus,
      reason: "target/bom.json " + file.reason,
    };
  }
  const bom = scannerObject(file.text);
  if (
    bom?.bomFormat !== "CycloneDX" ||
    typeof bom.specVersion !== "string" ||
    !/^\d+\.\d+$/.test(bom.specVersion) ||
    (bom.components !== undefined && !Array.isArray(bom.components))
  ) {
    return {
      target: dir,
      evidenceStatus: "malformed",
      reason: "target/bom.json must contain CycloneDX JSON with a specification version.",
    };
  }
  return undefined;
}

// The opening angle bracket in the comment token uses \x3c for Semgrep compatibility.
const POM_TOKEN =
  /\x3c!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<([A-Za-z_][\w:.-]*)(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(\/?)>|<\/([A-Za-z_][\w:.-]*)\s*>|([^<]+)/y;

interface PomStructure {
  stack: string[];
  hasProject: boolean;
}

function localName(tag: string): string {
  return tag.slice(tag.lastIndexOf(":") + 1);
}

function isReactorModule(stack: string[]): boolean {
  return (
    stack.length === 3 && localName(stack[1]) === "modules" && localName(stack[2]) === "module"
  );
}

function acceptPomToken(
  state: PomStructure,
  opening: string | undefined,
  empty: string | undefined,
  closing: string | undefined,
  content: string,
): boolean {
  if (closing) return state.stack.pop() === closing;
  if (!opening) return state.stack.length > 0 || !content.trim();
  if (isReactorModule(state.stack)) return false;
  if (state.stack.length === 0) {
    if (state.hasProject || localName(opening) !== "project") return false;
    state.hasProject = true;
  }
  if (!empty) state.stack.push(opening);
  return true;
}

/** Read literal, unconditional project/modules/module declarations from a complete POM. */
function declaredModules(xml: string): string[] | undefined {
  const state: PomStructure = { stack: [], hasProject: false };
  const pattern = new RegExp(POM_TOKEN);
  const modules: string[] = [];
  let value = "";
  while (pattern.lastIndex < xml.length) {
    const token = pattern.exec(xml);
    if (!token) return undefined;
    const [, cdata, opening, empty, closing, text] = token;
    const insideModule = isReactorModule(state.stack);
    const content = cdata ?? text ?? "";
    if (!acceptPomToken(state, opening, empty, closing, content)) return undefined;
    if (!insideModule) continue;
    if (closing) {
      modules.push(value.trim());
      value = "";
    } else {
      value += content;
    }
  }
  if (state.hasProject && state.stack.length === 0) return modules;
}

function readProject(root: string, dir: string, gaps: MavenGap[]): MavenProject {
  const prefix = dir === "." ? "" : dir + "/";
  const bom = prefix + "target/bom.json";
  const pom = readMavenFile(root, prefix + "pom.xml", MAX_POM_BYTES);
  const modules = "text" in pom ? declaredModules(pom.text) : undefined;
  if (!("text" in pom)) {
    gaps.push({ target: dir, evidenceStatus: pom.evidenceStatus, reason: "pom.xml " + pom.reason });
  } else if (!modules) {
    gaps.push({
      target: dir,
      evidenceStatus: "malformed",
      reason: "Could not read a complete pom.xml.",
    });
  }
  return { dir, bom, bomGap: inspectBom(root, dir, bom), modules: modules ?? [] };
}

/** Find Maven projects and aggregate BOMs within the existing discovery depth. */
function mavenProjects(path: string): MavenDiscovery {
  const found: MavenDiscovery = { projects: [], gaps: [] };
  let root: string;
  try {
    root = realpathSync(path);
  } catch {
    found.gaps.push({
      target: ".",
      evidenceStatus: "unavailable",
      reason: "Could not open the Maven project directory.",
    });
    return found;
  }
  walkProjects(root, ".", 0, found, []);
  return found;
}

function inConventionalSources(path: string, projectDirs: string[]): boolean {
  return projectDirs.some((dir) => {
    const src = dir === "." ? "src" : dir + "/src";
    if (path === src) return true;
    if (!path.startsWith(src + "/")) return false;
    const kind = path.slice(src.length + 1).split("/", 1)[0];
    return kind === "main" || kind === "test";
  });
}

function walkProjects(
  root: string,
  dir: string,
  depth: number,
  found: MavenDiscovery,
  projectDirs: string[],
): void {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    found.gaps.push({
      target: dir,
      evidenceStatus: "unavailable",
      reason: "Could not list the directory during Maven project discovery.",
    });
    return;
  }
  if (entries.some((entry) => entry.name === "pom.xml")) {
    found.projects.push(readProject(root, dir, found.gaps));
    projectDirs = [...projectDirs, dir];
  }
  const children = entries
    .filter((entry) => entry.isDirectory() && !SKIP.has(entry.name))
    .map((entry) => (dir === "." ? entry.name : dir + "/" + entry.name));
  if (depth === MAX_DEPTH && children.some((path) => !inConventionalSources(path, projectDirs))) {
    found.gaps.push({
      target: dir,
      evidenceStatus: "partial",
      reason: `Maven project discovery reached its depth limit of ${MAX_DEPTH}.`,
    });
    return;
  }
  if (depth === MAX_DEPTH) return;
  for (const child of children) walkProjects(root, child, depth + 1, found, projectDirs);
}

function moduleDirectory(root: string, dir: string, module: string): string | undefined {
  if (!module || isAbsolute(module) || module.includes("${") || module.includes("&")) return;
  const path = relative(root, resolve(root, dir, module));
  if (!outsideRoot(path)) return path.split(sep).join("/") || ".";
}

function bomSources(
  root: string,
  projects: MavenProject[],
  gaps?: MavenGap[],
): Map<string, string> {
  const byDir = new Map(projects.map((project) => [project.dir, project]));
  const sources = new Map<string, string>();
  for (const project of projects) {
    if (project.bomGap) continue;
    const pending = [project];
    for (let current = pending.pop(); current; current = pending.pop()) {
      if (sources.has(current.dir)) continue;
      sources.set(current.dir, project.bom);
      addReactorModules(root, current, byDir, pending, gaps);
    }
  }
  return sources;
}

function addReactorModules(
  root: string,
  project: MavenProject,
  byDir: Map<string, MavenProject>,
  pending: MavenProject[],
  gaps?: MavenGap[],
): void {
  let incomplete = false;
  for (const module of project.modules) {
    const dir = moduleDirectory(root, project.dir, module);
    const child = dir === undefined ? undefined : byDir.get(dir);
    if (child) pending.push(child);
    else incomplete = true;
  }
  if (incomplete && gaps) {
    gaps.push({
      target: project.dir,
      evidenceStatus: "partial",
      reason: "Maven project discovery could not resolve all declared reactor modules.",
    });
  }
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
  const repoSources = bomSources(repoRoot, mavenProjects(repoRoot).projects);
  for (const project of projects) {
    if (localSources.has(project.dir)) continue;
    const path = project.dir === "." ? prefix : prefix + "/" + project.dir;
    const source = repoSources.get(path);
    if (source) found.set(project.dir, join(repoRoot, source));
  }
  return found;
}

interface BomInput {
  dir: string;
  bom: string;
}

function mavenInputs(root: string): {
  projectCount: number;
  gaps: MavenGap[];
  inputs: BomInput[];
  uncovered: string[];
} {
  const { projects, gaps } = mavenProjects(root);
  const localSources = bomSources(root, projects, gaps);
  const inheritedSources = ancestorSources(root, projects, localSources);
  const inputs: BomInput[] = [];
  const uncovered: string[] = [];
  for (const { dir, bom, bomGap } of projects) {
    if (!bomGap) {
      inputs.push({ dir, bom });
    } else if (!localSources.has(dir) && !inheritedSources.has(dir)) {
      gaps.push(bomGap);
      uncovered.push(dir);
    }
  }
  inputs.push(...[...inheritedSources].map(([dir, bom]) => ({ dir, bom })));
  return { projectCount: projects.length, inputs, gaps, uncovered };
}

function coverageWarning(
  gaps: MavenGap[],
  uncovered: string[],
): Pick<
  SecurityCheckResult,
  "detail" | "severity" | "didNotRun" | "scanIncomplete" | "evidenceStatus" | "suggestion"
> {
  const gapDetail = gaps
    .map(({ target, reason }) => sanitizeDisplayText(target) + ": " + reason)
    .join(" ");
  const warning = {
    severity: "high",
    didNotRun: true,
    scanIncomplete: true,
    evidenceStatus: gaps.length === 1 ? gaps[0].evidenceStatus : "partial",
  } as const;
  if (uncovered.length === 0) {
    return { ...warning, detail: `Maven SBOM input scope is incomplete. ${gapDetail}` };
  }
  const projectWord = uncovered.length === 1 ? "project" : "projects";
  const directories = uncovered.map(sanitizeDisplayText);
  const firstDirectory = directories[0] === "." ? "this directory" : directories[0];
  return {
    ...warning,
    detail: `pom.xml lists direct dependencies only. ${directories.length} Maven ${projectWord} lack a valid CycloneDX target/bom.json: ${directories.join(", ")}. Run ${COMMAND} in each listed directory, then run kit scan. ${gapDetail}`,
    suggestion: `Run ${COMMAND} in ${firstDirectory}. Then run kit scan to check the generated SBOM.`,
  };
}

/** State the available transitive inputs and any known structural gaps. */
export async function checkMavenSbomCoverage(root: string): Promise<SecurityCheckResult> {
  const { projectCount, gaps, inputs, uncovered } = mavenInputs(root);
  const row = { category: "supply-chain", name: "Maven SBOM input" } as const;
  if (projectCount === 0) return { ...row, status: "skip", detail: "no pom.xml found" };
  if (gaps.length > 0) {
    return { ...row, status: "warn", ...coverageWarning(gaps, uncovered) };
  }
  const inputCount = new Set(inputs.map((input) => input.bom)).size;
  return {
    ...row,
    status: "pass",
    detail: `${inputCount} CycloneDX BOM input(s) cover ${projectCount} Maven project(s) for osv-scanner and grype in kit scan. This check confirms input availability.`,
  };
}

function sbomScanners(
  inputs: BomInput[],
  grype: ScannerDef | undefined,
  osv: ScannerDef | undefined,
): ScannerDef[] {
  const result: ScannerDef[] = [];
  const seen = new Set<string>();
  for (const project of inputs) {
    if (seen.has(project.bom)) continue;
    seen.add(project.bom);
    if (grype) {
      result.push({
        ...grype,
        id: `grype-sbom:${project.dir}`,
        evidence: undefined,
        args: [`sbom:${project.bom}`, "-o", "sarif", "-q"],
      });
    }
    if (osv) {
      result.push({
        ...osv,
        id: `osv-scanner-sbom:${project.dir}`,
        args: ["scan", "source", "--format", "json", "-L", project.bom],
      });
    }
  }
  return result;
}

/** Plan scanner inputs and report structural scope gaps before any delegate runs. */
export function planMavenSbomScans(
  root: string,
  delegates?: readonly string[],
): { scanners: ScannerDef[]; gaps: MavenGap[] } {
  const grype = isScannerEnabled("grype", delegates)
    ? SCANNERS.find((s) => s.id === "grype")
    : undefined;
  const osv = isScannerEnabled("osv-scanner", delegates)
    ? SCANNERS.find((s) => s.id === "osv-scanner")
    : undefined;
  if (!grype && !osv) return { scanners: [], gaps: [] };

  const { inputs, gaps } = mavenInputs(root);
  return { scanners: sbomScanners(inputs, grype, osv), gaps };
}

/** Give delegates the BOM path explicitly because target/ is usually gitignored. */
export function mavenSbomScanners(root: string, delegates?: readonly string[]): ScannerDef[] {
  return planMavenSbomScans(root, delegates).scanners;
}
