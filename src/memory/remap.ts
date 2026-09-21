import { posix, resolve, win32 } from "node:path";
import { resolveLocalProjectPath } from "./project.js";

export interface ProjectMapping {
  from: string;
  to: string;
}

export interface MergeScopeOptions {
  /** Rehome the entire imported store. Intended for a single-project export. */
  remapProject?: string;
  /** Selective origin-to-local mappings for multi-project stores. */
  projectMappings?: ProjectMapping[];
}

function sourcePath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//")) {
    const normalized = win32.normalize(path).replace(/\\/g, "/");
    return /^[A-Za-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/$/, "");
  }
  return posix.normalize(path).replace(/\/$/, "") || "/";
}

/** Validate the entire map before an import can mutate the destination. */
export function parseProjectMappings(value: unknown = []): ProjectMapping[] {
  if (!Array.isArray(value)) throw new Error("project mappings must be an array of {from, to}");
  const seen = new Set<string>();
  return value
    .map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error("invalid project mapping");
      const { from, to } = entry as Record<string, unknown>;
      if (typeof from !== "string" || (!posix.isAbsolute(from) && !win32.isAbsolute(from))) {
        throw new Error("project mapping from must be an absolute source path");
      }
      if (typeof to !== "string" || !to.trim())
        throw new Error("project mapping to must be a local path");
      const normalized = sourcePath(from);
      if (seen.has(normalized)) throw new Error("duplicate project mapping source");
      seen.add(normalized);
      return { from: normalized, to: resolveLocalProjectPath(to) };
    })
    .sort((a, b) => b.from.length - a.from.length);
}

/** Only explicit local mappings change recall scope; origin paths remain untouched. */
export function createProjectMapper(
  opts: MergeScopeOptions,
): (origin: string | undefined) => string | undefined {
  if (opts.remapProject !== undefined) {
    if (!opts.remapProject.trim()) throw new Error("remap project must be a nonempty local path");
    if (opts.projectMappings?.length)
      throw new Error("choose remap-project or project mappings, not both");
    const root = resolveLocalProjectPath(opts.remapProject);
    return () => root;
  }
  const mappings = parseProjectMappings(opts.projectMappings ?? []);
  return (origin) => {
    if (!origin) return undefined;
    const path = sourcePath(origin);
    for (const mapping of mappings) {
      if (path === mapping.from) return mapping.to;
      const prefix = mapping.from.endsWith("/") ? mapping.from : `${mapping.from}/`;
      if (path.startsWith(prefix)) return resolve(mapping.to, path.slice(prefix.length));
    }
    return undefined;
  };
}
