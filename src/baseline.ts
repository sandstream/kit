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

/**
 * Strict parse of baseline file content. Throws on anything that isn't a
 * well-formed, version-1 baseline object WITH a `categories` object — a bare
 * `{"version":1}` used to parse "successfully" and then blow up later in
 * `baselineGet` with a `Cannot read properties of undefined` TypeError.
 */
function parseBaseline(raw: string): Baseline {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("baseline is not a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (o.version !== 1) throw new Error(`unsupported baseline version: ${o.version}`);
  if (!o.categories || typeof o.categories !== "object" || Array.isArray(o.categories)) {
    throw new Error("baseline missing 'categories' object");
  }
  return parsed as Baseline;
}

export async function loadBaseline(cwd = process.cwd()): Promise<Baseline> {
  const path = resolve(cwd, BASELINE_FILE);
  if (!(await pathExists(path))) return { ...EMPTY_BASELINE };
  try {
    const raw = await readFile(path, "utf-8");
    return parseBaseline(raw);
  } catch (err) {
    throw new Error(
      `failed to read ${BASELINE_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Never-throws loader for the GATE paths (`kit check`, `kit review`, MCP `kit_check`).
 * A baseline only ever SUPPRESSES findings, so a malformed / unreadable / tampered file
 * must not crash the gate: we fail CLOSED by ignoring it (an empty baseline suppresses
 * nothing, so every finding gates) and return `ignored` with the reason so the caller
 * can surface it as a visible finding instead of a silent swallow. This is the fix for
 * the crash where a hand-written or corrupted `.kit-baseline.json` (no `version`, no
 * `categories`, non-JSON, null, array, …) took down `kit check` with an uncaught
 * exception and — in `--json` mode — emitted zero stdout (a denial-of-verdict any
 * process able to drop the file could trigger).
 */
export async function loadBaselineForGate(
  cwd = process.cwd(),
): Promise<{ baseline: Baseline; ignored: string | null }> {
  const path = resolve(cwd, BASELINE_FILE);
  if (!(await pathExists(path))) return { baseline: { ...EMPTY_BASELINE }, ignored: null };
  try {
    const raw = await readFile(path, "utf-8");
    return { baseline: parseBaseline(raw), ignored: null };
  } catch (err) {
    return {
      baseline: { ...EMPTY_BASELINE },
      ignored: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Lookup baseline entries for one category + key. Returns empty array if absent. */
export function baselineGet(baseline: Baseline, category: string, key: string): string[] {
  // `?.` on `categories` too: a hand-written baseline may omit it entirely.
  return baseline.categories?.[category]?.[key] ?? [];
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
