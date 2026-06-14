/**
 * Generic baseline file for any kit check category.
 *
 * Pattern (copied from `.checkov.yaml`): freeze the set of currently
 * acceptable warnings so future runs only fail on NET-NEW findings.
 *
 * One file (`.kit-baseline.json`) keyed by check category. Stale
 * entries auto-prune on `kit baseline freeze` so the file shrinks
 * as the codebase improves.
 *
 *   {
 *     "version": 1,
 *     "generated": "2026-05-30T09:50:00Z",
 *     "categories": {
 *       "tests": { "untested_files": ["src/legacy.ts", ...] },
 *       "design": { "a11y_violations": ["btn-name", "color-contrast"] }
 *     }
 *   }
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

export const BASELINE_FILE = ".kit-baseline.json";

export interface Baseline {
  version: 1;
  generated: string;
  categories: Record<string, Record<string, string[]>>;
}

const EMPTY_BASELINE: Baseline = {
  version: 1,
  generated: new Date(0).toISOString(),
  categories: {},
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadBaseline(cwd = process.cwd()): Promise<Baseline> {
  const path = resolve(cwd, BASELINE_FILE);
  if (!(await pathExists(path))) return { ...EMPTY_BASELINE };
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) throw new Error(`unsupported baseline version: ${parsed.version}`);
    return parsed;
  } catch (err) {
    throw new Error(
      `failed to read ${BASELINE_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Lookup baseline entries for one category + key. Returns empty array if absent. */
export function baselineGet(baseline: Baseline, category: string, key: string): string[] {
  return baseline.categories[category]?.[key] ?? [];
}

/**
 * Replace the entries for one category+key. Mutates `baseline`.
 * Empty array drops the key. Empty category drops the category.
 */
export function baselineSet(
  baseline: Baseline,
  category: string,
  key: string,
  entries: string[],
): void {
  if (entries.length === 0) {
    if (baseline.categories[category]) {
      delete baseline.categories[category][key];
      if (Object.keys(baseline.categories[category]).length === 0) {
        delete baseline.categories[category];
      }
    }
    return;
  }
  baseline.categories[category] ??= {};
  baseline.categories[category][key] = [...entries].sort();
}

export async function saveBaseline(baseline: Baseline, cwd = process.cwd()): Promise<void> {
  baseline.generated = new Date().toISOString();
  const path = resolve(cwd, BASELINE_FILE);
  await writeFile(path, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
}
