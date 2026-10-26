import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

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
 * True when NUL-separated `git ls-files -z` output lists a file under a terraform providers
 * directory. That directory is download output and is normally ignored, so a tracked file there is
 * suspicious and must be scanned like any other. NUL separation keeps odd file names unquoted.
 */
export function trackedProviderFiles(lsFilesZ: string): boolean {
  return lsFilesZ
    .split("\0")
    .some((path) => path.startsWith(PROVIDER_PATH) || path.includes("/" + PROVIDER_PATH));
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

/**
 * Decide from two git results whether to scan the provider directory. Outside a repository nothing
 * can be tracked. Inside one, a failed listing means "unknown", and unknown is treated as tracked.
 */
export function providersTracked(inside: GitResult, listing: GitResult): boolean {
  if (!inside.ok) return false;
  return listing.ok ? trackedProviderFiles(listing.stdout) : true;
}

/** Ask git whether the provider directory holds tracked files. See providersTracked. */
export async function scanProvidersTracked(cwd: string): Promise<boolean> {
  const inside = await execFileNoThrow("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  const listing = await execFileNoThrow("git", ["ls-files", "-z"], { cwd, maxBuffer: 64 << 20 });
  return providersTracked(inside, listing);
}
