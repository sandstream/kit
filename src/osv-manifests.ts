/**
 * Does the repo hold a manifest of an ecosystem that only osv-scanner covers
 * (go, rust, php, ruby, dart)? Subprojects count: a Tauri app keeps its lockfile in
 * `src-tauri/`, and a root-only check read that as "nothing to scan" when osv-scanner
 * was missing. The walk is bounded so it stays cheap on every `kit check`.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const MANIFESTS = new Set([
  "go.mod",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "pubspec.lock",
]);
const SKIPPED_DIRS = new Set(["node_modules", "target", ".git", "dist", "vendor", ".venv"]);
const MAX_DEPTH = 5;
const MAX_ENTRIES = 5000;

export async function hasOsvManifest(root: string): Promise<boolean> {
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return false;
      if (entry.isFile() && MANIFESTS.has(entry.name)) return true;
    }
    if (depth >= MAX_DEPTH) return false;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
      if (await walk(join(dir, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(root, 0);
}
