/**
 * How much of a project's dependency tree is weight it gets little from.
 *
 * Everything here is read from a lockfile, a manifest and the project's own source. Nothing is
 * executed and no model is asked. The result is a measurement and a short list of things worth a
 * look, not a verdict: a package that nothing imports may still be used by a tool kit cannot see,
 * so the caller says what the analysis cannot see.
 *
 * Only npm's lockfile (version 2 and 3, which carry a flat `packages` map) is read here.
 */

export interface NpmLockEntry {
  name?: string;
  version?: string;
  dev?: boolean;
  optional?: boolean;
  link?: boolean;
  resolved?: string;
  hasInstallScript?: boolean;
  engines?: { node?: string };
  os?: string[];
  cpu?: string[];
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface NpmLock {
  lockfileVersion?: number;
  packages?: Record<string, NpmLockEntry>;
}

export interface ProjectManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  scripts?: Record<string, string>;
}

/** What the project's own files say about its dependencies. */
export interface SurfaceUsage {
  /** Number of source files that import each package, by package name. Tests included. */
  importSites: ReadonlyMap<string, number>;
  /** The same count without test files. Absent means "no split": importSites is used for both. */
  productionImportSites?: ReadonlyMap<string, number>;
  /** Scripts, config files and workflow files as one text, for tools that are run and not imported. */
  scriptText: string;
}

export interface DirectDependency {
  name: string;
  kind: "prod" | "dev";
  /** Packages in its closure, not counting itself. */
  brings: number;
  /** Of those, the ones no other direct dependency also needs. */
  onlyThrough: number;
  /** Source files that import it, tests included. */
  importSites: number;
  /** Source files that import it, tests excluded. */
  productionSites: number;
}

export interface SurfaceTotals {
  direct: number;
  directProd: number;
  directDev: number;
  /** Unique third-party package names in the lockfile. */
  all: number;
  shipped: number;
  devOnly: number;
}

export type SurfaceRule = "unused" | "heavy" | "node-pin" | "duplicates" | "install-scripts";

export interface SurfaceFinding {
  rule: SurfaceRule;
  subject: string;
  /** For a heavy dependency, a sentence. For an unused one, just the name. */
  message: string;
  suggestion: string;
  /** Orders findings of one rule: the packages freed by removing the subject. */
  weight: number;
}

export interface SurfaceReport {
  totals: SurfaceTotals;
  direct: DirectDependency[];
  findings: SurfaceFinding[];
}

/**
 * A dependency is "heavy" when removing it would free at least this many packages (the ones only it
 * needs), and production code imports it in at most this many files. Shared weight does not count:
 * ten packages that all need the same forty frees nothing when one of them goes.
 */
const HEAVY_ONLY_THROUGH = 15;
const HEAVY_MAX_IMPORT_SITES = 3;
const LISTED = 5;

const nameOf = (loc: string): string => loc.replace(/^.*node_modules\//, "");

function isThirdParty(loc: string, entry: NpmLockEntry): boolean {
  return loc.includes("node_modules/") && entry.link !== true;
}

/** Resolve a dependency from a package location the way Node does: the nearest node_modules up. */
function resolveFrom(
  packages: Record<string, NpmLockEntry>,
  loc: string,
  name: string,
): string | null {
  let base = loc;
  for (;;) {
    const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
    if (packages[candidate] && packages[candidate].link !== true) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut >= 0 ? base.slice(0, cut) : "";
  }
}

/** The package names reachable from one location, not counting the location itself. */
function closureOf(
  packages: Record<string, NpmLockEntry>,
  start: string,
  direct: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const loc = stack.pop() as string;
    if (seen.has(loc)) continue;
    seen.add(loc);
    const e = packages[loc];
    // A peer the project depends on directly is the project's own weight, not this package's.
    const peers = Object.fromEntries(
      Object.entries(e.peerDependencies ?? {}).filter(([name]) => !direct.has(name)),
    );
    const deps = { ...e.dependencies, ...e.optionalDependencies, ...peers };
    for (const dep of Object.keys(deps)) {
      const next = resolveFrom(packages, loc, dep);
      if (next) stack.push(next);
    }
  }
  seen.delete(start);
  return new Set([...seen].map(nameOf));
}

function totalsOf(
  packages: Record<string, NpmLockEntry>,
  manifest: ProjectManifest,
): SurfaceTotals {
  const all = new Set<string>();
  const dev = new Set<string>();
  const shipped = new Set<string>();
  for (const [loc, entry] of Object.entries(packages)) {
    if (!isThirdParty(loc, entry)) continue;
    all.add(nameOf(loc));
    (entry.dev ? dev : shipped).add(nameOf(loc));
  }
  const directProd = Object.keys(manifest.dependencies ?? {}).length;
  const directDev = Object.keys(manifest.devDependencies ?? {}).length;
  return {
    direct: directProd + directDev,
    directProd,
    directDev,
    all: all.size,
    shipped: shipped.size,
    devOnly: [...dev].filter((n) => !shipped.has(n)).length,
  };
}

function directDependencies(
  packages: Record<string, NpmLockEntry>,
  manifest: ProjectManifest,
  usage: SurfaceUsage,
): DirectDependency[] {
  const declared: [string, "prod" | "dev"][] = [
    ...Object.keys(manifest.dependencies ?? {}).map((n): [string, "prod" | "dev"] => [n, "prod"]),
    ...Object.keys(manifest.devDependencies ?? {}).map((n): [string, "prod" | "dev"] => [n, "dev"]),
  ];
  const closures = new Map<string, Set<string>>();
  const directNames = new Set(declared.map(([name]) => name));
  for (const [name] of declared) {
    const loc = resolveFrom(packages, "", name);
    if (loc) closures.set(name, closureOf(packages, loc, directNames));
  }
  return declared
    .filter(([name]) => closures.has(name))
    .map(([name, kind]) => {
      const mine = closures.get(name) as Set<string>;
      const others = new Set<string>();
      for (const [other, set] of closures) {
        if (other === name) continue;
        others.add(other);
        for (const n of set) others.add(n);
      }
      return {
        name,
        kind,
        brings: mine.size,
        onlyThrough: [...mine].filter((n) => !others.has(n)).length,
        importSites: usage.importSites.get(name) ?? 0,
        productionSites: (usage.productionImportSites ?? usage.importSites).get(name) ?? 0,
      };
    });
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function binNames(entry: NpmLockEntry | undefined): string[] {
  if (!entry?.bin) return [];
  return typeof entry.bin === "string" ? [] : Object.keys(entry.bin);
}

/** True when the package or one of its commands is named in the scripts, configs or workflows. */
function mentioned(name: string, bins: string[], text: string): boolean {
  return [name, ...bins].some((n) =>
    new RegExp(`(^|[^\\w@/-])${escapeRegex(n)}($|[^\\w-])`).test(text),
  );
}

function unusedFindings(
  direct: DirectDependency[],
  packages: Record<string, NpmLockEntry>,
  usage: SurfaceUsage,
): SurfaceFinding[] {
  // Runtime dependencies only. A development tool is often run without being named by a script
  // (a plugin its host loads by short name, a compiler a build calls), and judging those gave false
  // alarms on real projects. A runtime dependency that no file imports is a much stronger signal.
  return direct
    .filter((d) => d.kind === "prod" && d.importSites === 0 && !d.name.startsWith("@types/"))
    .filter((d) => {
      const entry = packages[`node_modules/${d.name}`];
      return !mentioned(d.name, binNames(entry), usage.scriptText);
    })
    .map((d) => ({
      rule: "unused" as const,
      subject: d.name,
      message: d.name,
      suggestion:
        "Remove them if nothing needs them. A dependency still ships, and still has advisories, whether or not it is used.",
      weight: d.brings,
    }));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function useText(d: DirectDependency): string {
  if (d.productionSites === 0 && d.importSites === 0) {
    return "not imported (run from a script or a config)";
  }
  const inTests = d.importSites - d.productionSites;
  const base = `imported in ${plural(d.productionSites, "file")}`;
  return inTests > 0 ? `${base} (${inTests} more in tests)` : base;
}

function heavyFindings(direct: DirectDependency[]): SurfaceFinding[] {
  return direct
    .filter(
      (d) => d.onlyThrough >= HEAVY_ONLY_THROUGH && d.productionSites <= HEAVY_MAX_IMPORT_SITES,
    )
    .sort((a, b) => b.onlyThrough - a.onlyThrough || a.name.localeCompare(b.name))
    .map((d) => ({
      rule: "heavy" as const,
      subject: d.name,
      message: `${d.name}: brings ${plural(d.brings, "package")} (${d.onlyThrough} only through it); ${useText(d)}`,
      suggestion:
        d.kind === "prod"
          ? "Check how much of it is used. If it is a small part, the platform may cover it, or a few lines of your own."
          : "A development tool still adds packages and advisories. Check whether a lighter or built-in alternative covers what you use.",
      weight: d.onlyThrough,
    }));
}

/** The highest Node major an `engines.node` range allows. Infinity when open-ended or unreadable. */
export function maxNodeMajor(range: string): number {
  let highest = 0;
  for (const raw of range.split("||")) {
    const part = raw.trim();
    const upper = /<\s*(=?)\s*v?(\d+)/.exec(part);
    const closed = /^[\^~]?\s*v?(\d+)(\.[x*\d]+)*$/.exec(part);
    if (upper)
      highest = Math.max(highest, upper[1] === "=" ? Number(upper[2]) : Number(upper[2]) - 1);
    else if (closed) highest = Math.max(highest, Number(closed[1]));
    else return Infinity;
  }
  return highest === 0 && range.trim() === "" ? Infinity : highest;
}

/** The lowest Node major the project says it supports. Undefined when it declares none. */
function nodeFloor(manifest: ProjectManifest): number | undefined {
  const range = manifest.engines?.node;
  if (!range) return undefined;
  const majors = [...range.matchAll(/(?<![<\d.])(\d+)/g)].map((m) => Number(m[1]));
  return majors.length > 0 ? Math.min(...majors) : undefined;
}

function listed(items: string[]): string {
  const shown = items.slice(0, LISTED).join(", ");
  return items.length > LISTED ? `${shown}, +${items.length - LISTED} more` : shown;
}

function nodePinFindings(
  packages: Record<string, NpmLockEntry>,
  manifest: ProjectManifest,
): SurfaceFinding[] {
  const floor = nodeFloor(manifest);
  if (floor === undefined) return [];
  const held = new Map<string, string>();
  for (const [loc, entry] of Object.entries(packages)) {
    const range = entry.engines?.node;
    if (!range || !isThirdParty(loc, entry) || maxNodeMajor(range) >= floor) continue;
    // A package built for one operating system or CPU is optional and never installed elsewhere.
    if (entry.optional || entry.os || entry.cpu) continue;
    held.set(nameOf(loc), range);
  }
  if (held.size === 0) return [];
  const names = [...held].map(([n, r]) => `${n} (${r})`).sort();
  return [
    {
      rule: "node-pin",
      subject: "node",
      message: `${plural(held.size, "package")} cannot run on Node ${floor}, the project's floor: ${listed(names)}`,
      suggestion:
        "A package whose engines range stops below your Node floor holds the project to an old runtime. Replace or remove it.",
      weight: held.size,
    },
  ];
}

function duplicateFindings(packages: Record<string, NpmLockEntry>): SurfaceFinding[] {
  const versions = new Map<string, Set<string>>();
  for (const [loc, entry] of Object.entries(packages)) {
    if (!isThirdParty(loc, entry) || !entry.version) continue;
    const set = versions.get(nameOf(loc)) ?? new Set<string>();
    set.add(entry.version);
    versions.set(nameOf(loc), set);
  }
  const dupes = [...versions]
    .filter(([, set]) => set.size > 1)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  if (dupes.length === 0) return [];
  const text = dupes.map(([n, set]) => `${n} (${[...set].sort().join(", ")})`);
  return [
    {
      rule: "duplicates",
      subject: "versions",
      message: `${plural(dupes.length, "package")} installed in more than one version: ${listed(text)}`,
      suggestion: "Try `npm dedupe`, or align the version ranges that ask for different majors.",
      weight: dupes.length,
    },
  ];
}

function installScriptFindings(packages: Record<string, NpmLockEntry>): SurfaceFinding[] {
  const names = new Set<string>();
  for (const [loc, entry] of Object.entries(packages)) {
    if (isThirdParty(loc, entry) && !entry.dev && entry.hasInstallScript) names.add(nameOf(loc));
  }
  if (names.size === 0) return [];
  return [
    {
      rule: "install-scripts",
      subject: "install scripts",
      message: `${plural(names.size, "shipped package")} run install scripts: ${listed([...names].sort())}`,
      suggestion:
        "Review them with `kit supply-chain`. Install with `--ignore-scripts` where the package does not need them.",
      weight: names.size,
    },
  ];
}

/** Measure the dependency tree. Null when the lockfile has no flat package list to read. */
export function analyseSurface(input: {
  lock: NpmLock;
  manifest: ProjectManifest;
  usage: SurfaceUsage;
}): SurfaceReport | null {
  const { lock, manifest, usage } = input;
  const packages = lock.packages;
  if (!packages) return null;
  const direct = directDependencies(packages, manifest, usage);
  return {
    totals: totalsOf(packages, manifest),
    direct,
    findings: [
      ...unusedFindings(direct, packages, usage),
      ...heavyFindings(direct),
      ...nodePinFindings(packages, manifest),
      ...duplicateFindings(packages),
      ...installScriptFindings(packages),
    ],
  };
}
