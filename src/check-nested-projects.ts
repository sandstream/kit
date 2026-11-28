/**
 * A directory with no manifest is not a directory with nothing to scan.
 *
 * Run from a workspace root that holds several repos side by side — `web/`, `illithid/` — every
 * manifest-dependent scanner skips honestly ("no package.json found") and the summary line reads
 * *"All 25 checks passed ✓"*. Measured on one such tree: 15 of the 25 were skips, and running the
 * same command one directory down produced 30 known dependency vulnerabilities (high), 22 unpinned
 * dependencies and 18 secret-shaped strings in history. The green line was covering all of it.
 *
 * Each individual skip was *true* — npm audit genuinely has nothing to audit at that path. What was
 * missing is the row that states the consequence: this verdict describes an empty directory, and
 * the code lives somewhere it did not look. So this check exists to make the absence visible, and
 * to name the paths that were not covered.
 *
 * Deliberately a `warn`, not a `fail`: nothing is broken, and a scan of the wrong directory is the
 * operator's to fix by running kit where the code is. But it must never be a silent pass.
 */

import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import type { SecurityCheckResult } from "./check-security.js";

/** Manifests that mean "there is a project here worth scanning". */
const MANIFESTS = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
];

/**
 * Manifests that mean "there is a project here", for an ecosystem no kit scanner reads. Finding one
 * must not read as "no manifest here": the project is real, its dependencies are simply not
 * covered. Each entry names the ecosystem so the row can say which one.
 */
const UNREAD_MANIFESTS: readonly [string, string][] = [["build.zig.zon", "Zig"]];

/** Directories that never represent a project of the operator's own. */
const IGNORED = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".terraform",
  ".cache",
  ".turbo",
  "tmp",
]);

/** The manifests present in a directory, in MANIFESTS order. */
async function manifestsIn(dir: string): Promise<string[]> {
  const present = await Promise.all(
    MANIFESTS.map((m) =>
      access(join(dir, m)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return MANIFESTS.filter((_, i) => present[i]);
}

async function hasManifest(dir: string): Promise<boolean> {
  return (await manifestsIn(dir)).length > 0;
}

/** The unread-ecosystem manifests present in a directory, as `file (Ecosystem)` labels. */
async function unreadManifestsIn(dir: string): Promise<string[]> {
  const present = await Promise.all(
    UNREAD_MANIFESTS.map(([m]) =>
      access(join(dir, m)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return UNREAD_MANIFESTS.filter((_, i) => present[i]).map(([m, eco]) => `${m} (${eco})`);
}

/**
 * Immediate-child projects, plus one level deeper (a `packages/*` layout is the common case). Depth
 * is bounded at 2 on purpose: this is a "you are standing in the wrong directory" detector, not a
 * repository crawler, and an unbounded walk on a home directory would cost more than the check is
 * worth. Each project keeps the manifests found in it, so a skip is escalated only toward projects
 * its scanner would have read.
 */
async function findNestedManifests(root: string, maxDepth = 2): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || IGNORED.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = join(dir, e.name);
      const manifests = await manifestsIn(childAbs);
      if (manifests.length) {
        found[childRel] = manifests;
        // Do not descend into a project we already found: its own subpackages are that
        // project's business, and `kit check` there will enumerate them.
        continue;
      }
      await walk(childAbs, childRel, depth + 1);
    }
  };

  await walk(root, "", 1);
  return found;
}

/** The nested project paths, sorted. */
export async function findNestedProjects(root: string, maxDepth = 2): Promise<string[]> {
  return Object.keys(await findNestedManifests(root, maxDepth)).sort();
}

/**
 * True when the root declares npm/yarn workspaces in package.json, or pnpm workspaces in
 * pnpm-workspace.yaml, so a root-level scan does cover the children.
 */
async function declaresWorkspaces(root: string): Promise<boolean> {
  try {
    await access(join(root, "pnpm-workspace.yaml"));
    return true;
  } catch {
    /* not pnpm, read package.json */
  }
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as {
      workspaces?: unknown;
    };
    return Array.isArray(pkg.workspaces) || typeof pkg.workspaces === "object";
  } catch {
    return false;
  }
}

/** `crates/*` style member patterns: `*` and `?` match within one path segment. */
function memberMatcher(pattern: string): RegExp {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  const body = clean
    .split("")
    .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

/**
 * Nested paths that a root Cargo workspace lists in `[workspace] members` (minus `exclude`).
 *
 * Only when a root Cargo.lock exists: osv-scanner and cargo audit read the lockfile, and a
 * workspace's single Cargo.lock pins every member. Without it the root scan has nothing to read
 * for those crates, so they stay uncovered.
 */
async function cargoWorkspaceMembers(root: string, nested: string[]): Promise<string[]> {
  try {
    await access(join(root, "Cargo.lock"));
    const toml = parseToml(await readFile(join(root, "Cargo.toml"), "utf-8")) as {
      workspace?: { members?: unknown; exclude?: unknown };
    };
    const list = (v: unknown): RegExp[] =>
      Array.isArray(v) ? v.filter((m) => typeof m === "string").map(memberMatcher) : [];
    const members = list(toml.workspace?.members);
    const excluded = list(toml.workspace?.exclude);
    return nested.filter((n) => members.some((m) => m.test(n)) && !excluded.some((m) => m.test(n)));
  } catch {
    return [];
  }
}

export interface ScanScope {
  /** Does the directory kit ran in have a manifest of its own? */
  rootManifest: boolean;
  /** Project directories found below it, relative paths. */
  nested: string[];
  /** Does the root manifest declare workspaces, so a root-level scan covers the children? */
  workspaces: boolean;
  /** Nested paths a root Cargo workspace locks in its Cargo.lock, so the root scan reads them. */
  cargoMembers?: string[];
  /** The manifests each nested project holds. Absent means unknown: every project counts. */
  manifests?: Record<string, string[]>;
  /** Root manifests of ecosystems no kit scanner reads, as `file (Ecosystem)` labels. */
  unreadRoot?: string[];
}

/** The facts, gathered once: the row below and the skip escalation both read them. */
export async function scanScopeFacts(root: string): Promise<ScanScope> {
  const [rootManifest, manifests, unreadRoot] = await Promise.all([
    hasManifest(root),
    findNestedManifests(root),
    unreadManifestsIn(root),
  ]);
  const nested = Object.keys(manifests).sort();
  return {
    rootManifest,
    nested,
    manifests,
    unreadRoot,
    workspaces: rootManifest ? await declaresWorkspaces(root) : false,
    cargoMembers: rootManifest ? await cargoWorkspaceMembers(root, nested) : [],
  };
}

/**
 * True when kit was pointed at a directory that has no project of its own while projects sit below
 * it — the "I looked in the wrong place" case, as distinct from "there is nothing to scan".
 */
export function lookedInTheWrongPlace(scope: ScanScope): boolean {
  return !scope.rootManifest && scope.nested.length > 0;
}

/** Skip reasons that mean "no manifest at this path", i.e. exactly what a wrong directory produces. */
const MANIFEST_ABSENCE =
  /^no (package\.json|requirements\.txt|lockfiles|Maven\/Gradle|package\.json \/ requirements\.txt)/i;

/**
 * The manifests each skip reason is about, most specific first. A reason not listed here
 * (`no lockfiles`: osv-scanner reads every ecosystem's lockfile) is about any manifest.
 */
const SKIP_READS: [RegExp, readonly string[]][] = [
  [/^no package\.json (?:or|\/) requirements\.txt/i, ["package.json", "requirements.txt"]],
  [/^no package\.json/i, ["package.json"]],
  [/^no requirements\.txt/i, ["requirements.txt"]],
  [/^no Maven\/Gradle/i, ["pom.xml", "build.gradle", "build.gradle.kts"]],
];

/** The nested projects a scanner that skipped with this reason would have read. */
function projectsFor(detail: string, scope: ScanScope): string[] {
  const reads = SKIP_READS.find(([re]) => re.test(detail))?.[1];
  const { manifests } = scope;
  if (!reads || !manifests) return scope.nested;
  return scope.nested.filter((p) => manifests[p]?.some((m) => reads.includes(m)));
}

/**
 * Turn "nothing to scan" into "looked in the wrong place".
 *
 * A scanner that skips because this path has no manifest is telling the truth, and the sum of those
 * truths was a green verdict over a directory whose code lived one level down. When the scope facts
 * say kit is in the wrong place, those skips are no longer honest not-applicables: they are checks
 * that did not cover the code. They become warnings naming where the code is — the projects that
 * hold a manifest that scanner reads. A skip for an ecosystem no project below uses stays a skip.
 *
 * Only in that case. In an ordinary project, or a workspace root that genuinely covers its
 * children, a manifest-absence skip stays a skip — a check that warns everywhere gets switched off,
 * and then the case it was written for goes unnoticed too.
 */
export function escalateManifestSkips(
  results: SecurityCheckResult[],
  scope: ScanScope,
): SecurityCheckResult[] {
  if (!lookedInTheWrongPlace(scope)) return results;
  return results.map((r) => {
    if (r.status !== "skip" || !MANIFEST_ABSENCE.test(r.detail)) return r;
    const projects = projectsFor(r.detail, scope);
    if (!projects.length) return r;
    return {
      ...r,
      status: "warn" as const,
      severity: r.severity ?? ("medium" as const),
      detail: `${r.detail} — but ${projects.length} project(s) below do (${projects.slice(0, 3).join(", ")}); this scan looked in the wrong place`,
    };
  });
}

const NAME = "scan scope";

function say(
  status: SecurityCheckResult["status"],
  detail: string,
  extra: Partial<SecurityCheckResult> = {},
): SecurityCheckResult {
  return { category: "supply-chain", name: NAME, status, detail, ...extra };
}

/**
 * The row for a root whose only manifest is one kit does not read. It is a project, so "no manifest
 * here" would be false; and none of its dependencies were scanned, so it is not a pass either.
 */
function unreadRootRow(unread: string[], nested: string[], list: string): SecurityCheckResult {
  const below = nested.length ? `, nor of ${nested.length} project(s) below: ${list}` : "";
  return say(
    "warn",
    `manifest found here but not read: ${unread.join(", ")} — kit does not cover this ecosystem, so this verdict covers none of its dependencies${below}`,
    {
      severity: nested.length ? "high" : "medium",
      suggestion:
        "Review these dependencies by hand; for a git-pinned dependency, run kit triage repo <url>",
    },
  );
}

/**
 * Report what this run's directory does and does not cover.
 *
 * A root whose only manifest belongs to an ecosystem kit does not read (`build.zig.zon`) is a
 * project, not an empty directory: it warns that the manifest was found and not read, and still
 * names any projects below.
 *
 * Otherwise the four cases are distinct, and only one of them is a problem:
 *   - nothing nested: the scope is this project, say so;
 *   - a root manifest declaring workspaces: the children are covered by the root scan (a Cargo
 *     workspace covers only its locked members, so any other child still falls to the next case);
 *   - a root manifest without workspaces: the children are separate projects, not covered;
 *   - no root manifest at all: this verdict covers an empty directory. This is the false green.
 */
export async function checkScanScope(
  root: string,
  facts?: ScanScope,
): Promise<SecurityCheckResult> {
  const {
    rootManifest,
    nested,
    workspaces,
    cargoMembers = [],
    unreadRoot = [],
  } = facts ?? (await scanScopeFacts(root));

  const show = (paths: string[]): string =>
    paths.slice(0, 4).join(", ") + (paths.length > 4 ? `, +${paths.length - 4}` : "");
  const list = show(nested);

  if (!rootManifest && unreadRoot.length) return unreadRootRow(unreadRoot, nested, list);

  if (nested.length === 0) {
    return say(
      "pass",
      rootManifest ? "this project, scanned in place" : "no project manifests here or below",
    );
  }

  if (rootManifest && workspaces) {
    return say("pass", `${nested.length} nested package(s) covered via workspaces: ${list}`);
  }

  const uncovered = rootManifest ? nested.filter((n) => !cargoMembers.includes(n)) : nested;

  if (rootManifest && uncovered.length === 0) {
    return say("pass", `${nested.length} nested crate(s) covered via the Cargo workspace: ${list}`);
  }

  if (rootManifest) {
    return say(
      "warn",
      `${uncovered.length} nested project(s) NOT covered by this scan: ${show(uncovered)} — run kit check in each`,
      { severity: "medium", suggestion: `cd <project> && kit check --category security` },
    );
  }

  return say(
    "warn",
    `no manifest here — this verdict covers none of ${nested.length} project(s) below: ${list}`,
    {
      severity: "high",
      suggestion: `The manifest-dependent scanners had nothing to read at this path. Run: cd ${nested[0]} && kit check --category security`,
    },
  );
}
