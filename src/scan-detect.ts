import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Directories whose contents are vendored or downloaded, not the project's own files. */
const SKIPPED = new Set(["node_modules", ".git", ".terraform", "dist", "vendor"]);
const MAX_DEPTH = 3;

function matches(name: string, marker: string): boolean {
  return marker.startsWith("*") ? name.endsWith(marker.slice(1)) : name === marker;
}

function walk(dir: string, markers: string[], depth: number): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && markers.some((m) => matches(e.name, m))) return true;
  }
  if (depth >= MAX_DEPTH) return false;
  return entries.some(
    (e) => e.isDirectory() && !SKIPPED.has(e.name) && walk(join(dir, e.name), markers, depth + 1),
  );
}

/**
 * True when a scanner applies to this tree. A plain marker is an exact file name at the root.
 * A marker that starts with `*` (for example `*.tf`) matches that extension up to three levels
 * down, skipping vendored and downloaded directories so a copy there does not switch a scanner on.
 */
export function hasMarker(root: string, markers: string[]): boolean {
  const patterns = markers.filter((m) => m.startsWith("*"));
  const exact = markers.filter((m) => !m.startsWith("*"));
  if (exact.some((m) => existsSync(join(root, m)))) return true;
  return patterns.length > 0 && walk(root, patterns, 0);
}

const PROVIDER_PATH = ".terraform/providers/";

/**
 * True when `git ls-files` output lists a file under a terraform providers directory. That
 * directory is download output and is normally ignored, so a tracked file there is suspicious and
 * must be scanned like any other.
 */
export function trackedProviderFiles(lsFiles: string): boolean {
  return lsFiles
    .split("\n")
    .some((line) => line.startsWith(PROVIDER_PATH) || line.includes("/" + PROVIDER_PATH));
}
