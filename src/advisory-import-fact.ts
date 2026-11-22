/**
 * One fact beside a known-vulnerable dependency: does the project's own source import the package?
 *
 * The answer is read from the project's files and its lockfile. Nothing is run, no model is asked
 * and no network is used. It is a fact printed next to a finding. It never changes a finding's
 * severity, its status or its place in the list (kit-research `owasp-xpsd-vs-kit`).
 *
 * Stated limits:
 *
 * - The scan is text-level. No file is parsed into a syntax tree, so an import statement inside a
 *   comment or a string counts as an import. A package that is only named in prose does not.
 * - "Imported" means a source file names the package in an import. It says nothing about whether
 *   the vulnerable function is called.
 * - A specifier built at run time, an import in generated code and a tool started from a script or
 *   a config file are not seen. The wording for "nothing found" says so.
 * - Hidden directories (a name that starts with a dot), `node_modules`, build output, `vendor` and
 *   Python virtual environments are not read. Symbolic links are not followed.
 * - The walk is bounded. When a bound is hit the answer is `unknown`, never a partial one.
 * - Only npm's `package-lock.json` (version 2 and 3) is read for "who brings this package in".
 * - A PyPI distribution name and the module it installs can differ (`PyYAML` installs `yaml`), and
 *   nothing in the source tells which. Outside the short list in `PYPI_IMPORT_NAMES` a Python
 *   package that no file imports under its own name is `unknown`, never "not found".
 */
import { open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { importedPackages } from "./dependency-surface-imports.js";
import {
  graphFromNpmLock,
  type DepGraph,
  type NpmLock,
  type ProjectManifest,
} from "./dependency-surface.js";
import { sanitizeDisplayText } from "./display-text.js";

/** The package a normalized finding is about, as the scanner report names it. */
export interface AdvisoryPackage {
  name: string;
  ecosystem?: string;
}

export type ImportFact =
  | { status: "imported"; files: string[]; fileCount: number }
  | { status: "transitive-only"; via: string[] }
  | { status: "not-found-in-source" }
  | { status: "unknown"; reason: string };

/** The fact as it is attached to a finding: the structured answer and its one line of text. */
export type ReportedImportFact = ImportFact & { text: string };

export interface ImportIndexLimits {
  maxFiles?: number;
  maxFileBytes?: number;
}

type NpmLockState =
  | { kind: "graph"; graph: DepGraph; dependents: Map<string, string[]> }
  | { kind: "none"; reason: string };

export interface ImportIndex {
  /** Why no "nothing imports it" can be stated. Absent when every source file was read. */
  incomplete?: string;
  jsFiles: number;
  pyFiles: number;
  /** npm package name to the project files that import it. */
  npm: Map<string, string[]>;
  /** Top-level Python module name, lower case, to the project files that import it. */
  python: Map<string, string[]>;
  npmDirect: Set<string>;
  npmManifest: boolean;
  npmLock: NpmLockState;
  /** Normalised names found in requirements files and `pyproject.toml`. */
  pyDeclared: Set<string>;
}

const LISTED_FILES = 5;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const MAX_LOCK_BYTES = 64_000_000;
const MAX_MANIFEST_BYTES = 1_000_000;
const READ_BATCH = 32;

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "vendor", "venv", "__pycache__"]);
const JS_SOURCE = /\.(?:[mc]?[jt]s|[jt]sx)$/;
const PY_SOURCE = /\.py$/;
const PY_MANIFEST = /^(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg)$/;
const PLAIN_NAME = /^[@\w./~-]{1,214}$/;
const PLAIN_ECOSYSTEM = /^[\w .:-]{1,40}$/;

/**
 * PyPI distributions whose import name is not their own name. A labelled, hand-kept list of
 * well-known cases, not a registry: for these the import name is known, so "nothing imports it" can
 * be stated. Keys are normalised (lower case, `-` and `.` as `_`); values are lower case.
 */
const PYPI_IMPORT_NAMES: Readonly<Record<string, readonly string[]>> = {
  pyyaml: ["yaml"],
  beautifulsoup4: ["bs4"],
  pillow: ["pil"],
  scikit_learn: ["sklearn"],
  opencv_python: ["cv2"],
  python_dateutil: ["dateutil"],
  pyjwt: ["jwt"],
  python_dotenv: ["dotenv"],
  pycryptodome: ["crypto"],
  attrs: ["attr", "attrs"],
};

const normalisePyName = (name: string): string => name.toLowerCase().replace(/[-.]/g, "_");

const PY_IMPORT = /^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b|import[ \t]+([^\n#;]+))/gm;

/** The top-level modules a Python source text imports, lower case. */
function pythonImports(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(PY_IMPORT)) {
    const names = m[1] ? [m[1]] : m[2].split(",");
    for (const raw of names) {
      const top = raw.trim().split(/\s/)[0].split(".")[0];
      if (/^[A-Za-z_]\w*$/.test(top)) found.add(top.toLowerCase());
    }
  }
  return found;
}

interface Walk {
  files: string[];
  cap: number;
  capped: boolean;
}

async function walk(dir: string, state: Walk): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  // A Python virtual environment, whatever it is called.
  if (entries.some((e) => e.name === "pyvenv.cfg")) return;
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (state.capped) return;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), state);
    } else if (entry.isFile() && (JS_SOURCE.test(entry.name) || PY_SOURCE.test(entry.name))) {
      if (state.files.length >= state.cap) state.capped = true;
      else state.files.push(join(dir, entry.name));
    }
  }
}

/**
 * Read a file as text. `null` when it cannot be read or is over `cap` bytes. The size comes from
 * the open handle, so the file that was measured is the file that is read.
 */
async function readCapped(path: string, cap: number): Promise<string | null> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > cap) return null;
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readJson<T>(path: string, cap: number): Promise<T | "absent" | "unreadable"> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return "absent";
  await handle.close().catch(() => undefined);
  const text = await readCapped(path, cap);
  if (text === null) return "unreadable";
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : "unreadable";
  } catch {
    return "unreadable";
  }
}

const keysOf = (value: unknown): string[] =>
  value !== null && typeof value === "object" ? Object.keys(value) : [];

/** Every name the project or one of its workspaces depends on directly. */
function directNames(manifest: Record<string, unknown> | null, lock: NpmLock | null): Set<string> {
  const own = [manifest, ...workspaceEntries(lock)];
  const names = new Set<string>();
  for (const entry of own) {
    if (!entry) continue;
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const name of keysOf(entry[field])) names.add(name);
    }
  }
  return names;
}

/** The lockfile's entries for the project itself and its workspaces: the ones not under node_modules. */
function workspaceEntries(lock: NpmLock | null): Record<string, unknown>[] {
  return Object.entries(lock?.packages ?? {})
    .filter(([loc]) => !loc.includes("node_modules/"))
    .map(([, entry]) => entry as Record<string, unknown>);
}

function lockState(lock: NpmLock | "absent" | "unreadable", direct: Set<string>): NpmLockState {
  if (lock === "absent") {
    return { kind: "none", reason: "no package-lock.json (yarn and pnpm lockfiles are not read)" };
  }
  if (lock === "unreadable") return { kind: "none", reason: "unreadable lockfile" };
  const manifest: ProjectManifest = {
    dependencies: Object.fromEntries([...direct].map((name) => [name, "*"])),
  };
  const graph = graphFromNpmLock(lock, manifest);
  if (!graph) {
    return { kind: "none", reason: "package-lock.json has no packages map (lockfile version 1)" };
  }
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    for (const dep of node.deps) {
      const list = dependents.get(dep);
      if (list) list.push(node.id);
      else dependents.set(dep, [node.id]);
    }
  }
  return { kind: "graph", graph, dependents };
}

async function pythonDeclared(root: string): Promise<Set<string>> {
  const declared = new Set<string>();
  const top = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of top) {
    if (!entry.isFile() || !PY_MANIFEST.test(entry.name)) continue;
    const text = (await readCapped(join(root, entry.name), MAX_MANIFEST_BYTES)) ?? "";
    for (const m of text.matchAll(/[A-Za-z0-9][\w.-]*/g)) declared.add(normalisePyName(m[0]));
  }
  return declared;
}

function record(map: Map<string, string[]>, names: Iterable<string>, file: string): void {
  for (const name of names) {
    const list = map.get(name);
    if (list) list.push(file);
    else map.set(name, [file]);
  }
}

/**
 * Read the project once: which source files import which package, and what the manifest and the
 * lockfile hold. Build it once per run and ask it about every finding.
 */
export async function buildImportIndex(
  root: string,
  limits: ImportIndexLimits = {},
): Promise<ImportIndex> {
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const state: Walk = { files: [], cap: maxFiles, capped: false };
  await walk(root, state);
  const manifest = await readJson<Record<string, unknown>>(
    join(root, "package.json"),
    MAX_MANIFEST_BYTES,
  );
  const lock = await readJson<NpmLock>(join(root, "package-lock.json"), MAX_LOCK_BYTES);
  const direct = directNames(
    typeof manifest === "string" ? null : manifest,
    typeof lock === "string" ? null : lock,
  );
  const index: ImportIndex = {
    jsFiles: 0,
    pyFiles: 0,
    npm: new Map(),
    python: new Map(),
    npmDirect: direct,
    npmManifest: typeof manifest !== "string",
    npmLock: lockState(lock, direct),
    pyDeclared: await pythonDeclared(root),
  };
  if (state.capped) index.incomplete = `too many files (more than ${maxFiles} source files)`;
  for (let i = 0; i < state.files.length && !index.incomplete; i += READ_BATCH) {
    const batch = state.files.slice(i, i + READ_BATCH);
    const texts = await Promise.all(batch.map((file) => readCapped(file, maxBytes)));
    for (let j = 0; j < batch.length; j++) indexFile(index, root, batch[j], texts[j], maxBytes);
  }
  return index;
}

function indexFile(
  index: ImportIndex,
  root: string,
  file: string,
  text: string | null,
  maxBytes: number,
): void {
  if (text === null) {
    index.incomplete ??= `a source file could not be read or is over ${maxBytes} bytes`;
    return;
  }
  const shown = sanitizeDisplayText(relative(root, file).split(sep).join("/"));
  if (PY_SOURCE.test(file)) {
    index.pyFiles++;
    record(index.python, pythonImports(text), shown);
  } else {
    index.jsFiles++;
    record(index.npm, importedPackages(text), shown);
  }
}

const notChecked = (reason: string): ImportFact => ({ status: "unknown", reason });

function importedFact(files: string[]): ImportFact {
  const sorted = [...new Set(files)].sort();
  return { status: "imported", files: sorted.slice(0, LISTED_FILES), fileCount: sorted.length };
}

/** The direct dependencies whose tree holds the package, read from the lockfile graph. */
function broughtInBy(
  lock: Extract<NpmLockState, { kind: "graph" }>,
  name: string,
): string[] | null {
  const starts = [...lock.graph.nodes.values()].filter((n) => n.name === name).map((n) => n.id);
  if (starts.length === 0) return null;
  const reached = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const parent of lock.dependents.get(id) ?? []) stack.push(parent);
  }
  return [...lock.graph.direct]
    .filter(([, id]) => reached.has(id))
    .map(([direct]) => sanitizeDisplayText(direct))
    .sort();
}

function npmFact(index: ImportIndex, name: string): ImportFact {
  if (index.incomplete) return notChecked(index.incomplete);
  const files = index.npm.get(name);
  if (files) return importedFact(files);
  if (index.jsFiles === 0) return notChecked("no source files");
  if (index.npmDirect.has(name)) return { status: "not-found-in-source" };
  const lock = index.npmLock;
  if (lock.kind === "none") {
    return notChecked(
      index.npmManifest || !lock.reason.startsWith("no ")
        ? lock.reason
        : "no package.json or package-lock.json in the project root",
    );
  }
  const via = broughtInBy(lock, name);
  if (via === null) return notChecked("the package is not in this project's package-lock.json");
  return { status: "transitive-only", via };
}

function pythonFact(index: ImportIndex, name: string): ImportFact {
  if (index.incomplete) return notChecked(index.incomplete);
  const normal = normalisePyName(name);
  const known = PYPI_IMPORT_NAMES[normal];
  const files = (known ?? [normal]).flatMap((module) => index.python.get(module) ?? []);
  if (files.length > 0) return importedFact(files);
  if (index.pyFiles === 0) return notChecked("no source files");
  if (!known) {
    return notChecked(
      `a PyPI name and its import name can differ, and no file imports \`${normal}\``,
    );
  }
  if (!index.pyDeclared.has(normal)) {
    return notChecked("the package is not in a requirements file or pyproject.toml");
  }
  return { status: "not-found-in-source" };
}

/** The fact for one package. Pure over the index: no file is read here. */
export function importFactFor(index: ImportIndex, pkg: AdvisoryPackage): ImportFact {
  if (!PLAIN_NAME.test(pkg.name)) return notChecked("the package name is not a plain name");
  const ecosystem = (pkg.ecosystem ?? "").toLowerCase();
  if (ecosystem === "npm") return npmFact(index, pkg.name);
  if (ecosystem === "pypi") return pythonFact(index, pkg.name);
  if (!pkg.ecosystem) return notChecked("the report names no ecosystem");
  const shown = PLAIN_ECOSYSTEM.test(pkg.ecosystem) ? ` ${pkg.ecosystem}` : "";
  return notChecked(`ecosystem${shown} not supported (npm and PyPI are read)`);
}

/** The one line printed beside a finding. These strings are the honesty of the feature. */
export function importFactText(fact: ImportFact): string {
  switch (fact.status) {
    case "imported": {
      const more = fact.fileCount - fact.files.length;
      return `imported by project source: ${fact.files.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
    }
    case "transitive-only": {
      const [first, ...rest] = fact.via;
      const by = first ? `${first}${rest.length > 0 ? ` (+${rest.length} more)` : ""}` : "";
      return `not imported by project source; in the lockfile as a dependency of ${by || "other packages"}`;
    }
    case "not-found-in-source":
      return "not imported by anything kit read (dynamic or generated imports are not seen)";
    case "unknown":
      return `import use not checked: ${fact.reason}`;
  }
}

/**
 * Add `importFact` to every finding that names a package. The index is built once, and only when
 * a finding needs it. Nothing else on a finding is touched and the order is kept.
 */
export async function withImportFacts<T extends object>(
  root: string,
  findings: T[],
  limits?: ImportIndexLimits,
): Promise<(T & { importFact?: ReportedImportFact })[]> {
  let index: ImportIndex | undefined;
  const out: (T & { importFact?: ReportedImportFact })[] = [];
  for (const finding of findings) {
    const pkg = (finding as { package?: AdvisoryPackage }).package;
    if (!pkg || typeof pkg.name !== "string") {
      out.push(finding);
      continue;
    }
    index ??= await buildImportIndex(root, limits);
    const fact = importFactFor(index, pkg);
    out.push({ ...finding, importFact: { ...fact, text: importFactText(fact) } });
  }
  return out;
}
