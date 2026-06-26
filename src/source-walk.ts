/**
 * Shared synchronous source-file walker.
 *
 * Consolidates the per-check walkers that several analyzers used to duplicate
 * (check-tests, check-design, self-audit). Returns absolute paths so callers
 * can `readFileSync` / `existsSync` directly and relativize for display.
 *
 * Defaults:
 *   - exts:     ['.ts']
 *   - skipDirs: ['node_modules','dist','.next','.git','coverage']
 *   - dotdirs (any directory starting with '.') are skipped
 *   - `*.test.ts` is excluded unless `includeTests` is set
 */

import { readdirSync } from "node:fs";
import { join, extname } from "node:path";

export interface WalkOpts {
  /** File extensions to collect, e.g. ['.ts', '.tsx']. Default ['.ts']. */
  exts?: string[];
  /** Directory names to skip entirely. Default node_modules/dist/.next/.git/coverage. */
  skipDirs?: string[];
  /** When true, include `*.test.<ext>` files (excluded by default). */
  includeTests?: boolean;
}

const DEFAULT_EXTS = [".ts"];
const DEFAULT_SKIP_DIRS = ["node_modules", "dist", ".next", ".git", "coverage"];

function isTestFile(name: string, exts: string[]): boolean {
  return exts.some((ext) => name.endsWith(`.test${ext}`));
}

/**
 * Recursively collect source files under `root`.
 * Returns absolute paths. Unreadable directories are skipped silently
 * (the walk is best-effort; callers handle the empty/partial result).
 */
export function walkSourceFiles(root: string, opts: WalkOpts = {}): string[] {
  const exts = opts.exts ?? DEFAULT_EXTS;
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const includeTests = opts.includeTests ?? false;
  const skip = new Set(skipDirs);
  const out: string[] = [];

  function visit(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue;
        if (skip.has(e.name)) continue;
        visit(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.startsWith(".")) continue;
      if (!exts.includes(extname(e.name))) continue;
      if (!includeTests && isTestFile(e.name, exts)) continue;
      out.push(full);
    }
  }

  visit(root);
  return out;
}
