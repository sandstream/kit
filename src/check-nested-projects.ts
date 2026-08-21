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

async function hasManifest(dir: string): Promise<boolean> {
  for (const m of MANIFESTS) {
    try {
      await access(join(dir, m));
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/**
 * Immediate-child projects, plus one level deeper (a `packages/*` layout is the common case). Depth
 * is bounded at 2 on purpose: this is a "you are standing in the wrong directory" detector, not a
 * repository crawler, and an unbounded walk on a home directory would cost more than the check is
 * worth.
 */
export async function findNestedProjects(root: string, maxDepth = 2): Promise<string[]> {
  const found: string[] = [];

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
      if (await hasManifest(childAbs)) {
        found.push(childRel);
        // Do not descend into a project we already found: its own subpackages are that
        // project's business, and `kit check` there will enumerate them.
        continue;
      }
      await walk(childAbs, childRel, depth + 1);
    }
  };

  await walk(root, "", 1);
  return found.sort();
}

/** True when the root package.json declares workspaces, so a root-level scan does cover the children. */
async function declaresWorkspaces(root: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as {
      workspaces?: unknown;
    };
    return Array.isArray(pkg.workspaces) || typeof pkg.workspaces === "object";
  } catch {
    return false;
  }
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
 * Report what this run's directory does and does not cover.
 *
 * The four cases are distinct, and only one of them is a problem:
 *   - nothing nested: the scope is this project, say so;
 *   - a root manifest declaring workspaces: the children are covered by the root scan;
 *   - a root manifest without workspaces: the children are separate projects, not covered;
 *   - no root manifest at all: this verdict covers an empty directory. This is the false green.
 */
export async function checkScanScope(root: string): Promise<SecurityCheckResult> {
  const [rootManifest, nested] = await Promise.all([hasManifest(root), findNestedProjects(root)]);

  if (nested.length === 0) {
    return say(
      "pass",
      rootManifest ? "this project, scanned in place" : "no project manifests here or below",
    );
  }

  const list = nested.slice(0, 4).join(", ") + (nested.length > 4 ? `, +${nested.length - 4}` : "");

  if (rootManifest && (await declaresWorkspaces(root))) {
    return say("pass", `${nested.length} nested package(s) covered via workspaces: ${list}`);
  }

  if (rootManifest) {
    return say(
      "warn",
      `${nested.length} nested project(s) NOT covered by this scan: ${list} — run kit check in each`,
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
