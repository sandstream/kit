/**
 * Test-coverage enforcement.
 *
 * Walks src/ and reports source files without a sibling `.test.ts` (or
 * `.test.js`). Configurable per project via `.kit.toml`:
 *
 *   [tests]
 *   enforce = true                  # default false; turn on to gate
 *   src_globs = ["src/**\/*.ts"]    # what counts as source
 *   exclude  = ["src/**\/*.test.ts", "src/**\/index.ts"]
 *   require_smoke = true            # at least one @smoke-tagged e2e/*.spec.ts
 *   smoke_dirs = ["e2e", "tests/e2e"]
 *
 * Net-new vs baseline: existing untested files can be frozen via
 * `.kit-baseline.json` (see baseline.ts) — only new gaps then fail.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

export interface TestCheckResult {
  category: "tests";
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  files?: string[];
  severity?: "high" | "medium" | "low";
}

const DEFAULT_SRC_DIRS = ["src"];
const DEFAULT_EXCLUDE_SUFFIXES = [".test.ts", ".test.js", ".spec.ts", ".spec.js", ".d.ts"];
const DEFAULT_EXCLUDE_NAMES = ["index.ts", "index.js", "types.ts"];

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function walkSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        await visit(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".ts") && !e.name.endsWith(".js")) continue;
      if (DEFAULT_EXCLUDE_SUFFIXES.some((s) => e.name.endsWith(s))) continue;
      if (DEFAULT_EXCLUDE_NAMES.includes(e.name)) continue;
      out.push(full);
    }
  }
  await visit(root);
  return out;
}

function siblingTestPath(srcPath: string): string {
  return srcPath.replace(/\.(ts|js)$/, ".test.$1");
}

/**
 * Find source files without a sibling test file.
 * Returns relative paths so the result is stable across machines.
 */
export async function findUntestedSources(
  cwd = process.cwd(),
  srcDirs: string[] = DEFAULT_SRC_DIRS,
): Promise<string[]> {
  const untested: string[] = [];
  for (const dir of srcDirs) {
    const root = resolve(cwd, dir);
    if (!(await pathExists(root))) continue;
    const files = await walkSourceFiles(root);
    for (const file of files) {
      if (!(await pathExists(siblingTestPath(file)))) {
        untested.push(relative(cwd, file));
      }
    }
  }
  return untested.sort();
}

/** Look for at least one Playwright spec tagged `@smoke`. */
export async function hasSmokeTests(
  cwd = process.cwd(),
  smokeDirs: string[] = ["e2e", "tests/e2e", "smoke"],
): Promise<boolean> {
  for (const dir of smokeDirs) {
    const root = resolve(cwd, dir);
    if (!(await pathExists(root))) continue;
    const files = await walkSourceFiles(root);
    for (const file of files) {
      try {
        const content = await readFile(file, "utf-8");
        if (/@smoke\b/.test(content)) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

/**
 * Top-level test-enforcement check.
 * Loads baseline (if present) and only counts net-new untested files
 * against the gate.
 */
export async function checkTests(
  opts: {
    cwd?: string;
    enforce?: boolean;
    requireSmoke?: boolean;
    srcDirs?: string[];
    baseline?: string[];
  } = {},
): Promise<TestCheckResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const enforce = opts.enforce ?? false;
  const results: TestCheckResult[] = [];

  // No src/ at all = N/A
  const anyDirExists = (
    await Promise.all((opts.srcDirs ?? DEFAULT_SRC_DIRS).map((d) => pathExists(resolve(cwd, d))))
  ).some(Boolean);
  if (!anyDirExists) {
    results.push({
      category: "tests",
      name: "unit-test coverage",
      status: "skip",
      detail: "no src/ directory found",
    });
    return results;
  }

  const untested = await findUntestedSources(cwd, opts.srcDirs);
  const baseline = new Set(opts.baseline ?? []);
  const netNew = untested.filter((f) => !baseline.has(f));

  if (untested.length === 0) {
    results.push({
      category: "tests",
      name: "unit-test coverage",
      status: "pass",
      detail: "every source file has a sibling .test file",
    });
  } else if (netNew.length === 0) {
    results.push({
      category: "tests",
      name: "unit-test coverage",
      status: "warn",
      detail: `${untested.length} pre-existing untested file(s) (baseline-frozen)`,
      severity: "low",
    });
  } else {
    results.push({
      category: "tests",
      name: "unit-test coverage",
      status: enforce ? "fail" : "warn",
      detail: `${netNew.length} new untested file(s) (${untested.length} total)`,
      severity: enforce ? "high" : "medium",
      files: netNew.slice(0, 10),
    });
  }

  if (opts.requireSmoke) {
    const hasSmoke = await hasSmokeTests(cwd);
    results.push({
      category: "tests",
      name: "smoke test present",
      status: hasSmoke ? "pass" : enforce ? "fail" : "warn",
      detail: hasSmoke
        ? "at least one @smoke-tagged spec found"
        : "no @smoke-tagged e2e/*.spec.ts found",
      severity: hasSmoke ? undefined : enforce ? "high" : "medium",
    });
  }

  return results;
}
