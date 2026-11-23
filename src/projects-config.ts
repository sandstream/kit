import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";

/**
 * `[projects]` names the project directories of a repository that has several. The repo level
 * (git history, hooks, ignore rules) is checked once in the root, and each path here is checked as a
 * project of its own (manifests, dependencies, licences, infrastructure code).
 *
 * Declared, never guessed: a scope kit invents is a scope nobody reviewed.
 */
export interface ProjectsConfig {
  paths?: string[];
}

/** True for a path that is absolute or climbs out with `..`. Checked on the text, before any disk. */
function leavesRepo(path: string): boolean {
  if (isAbsolute(path)) return true;
  return normalize(path).split("\\").join("/").split("/").includes("..");
}

export const ProjectsSchema = z
  .object({
    paths: z
      .array(
        z.string().refine((p) => !leavesRepo(p), {
          message: "projects.paths must stay inside the repository (no absolute path, no ..)",
        }),
      )
      .optional(),
  })
  .passthrough();

export interface RefusedProject {
  path: string;
  reason: string;
  evidenceStatus: "missing" | "unsupported" | "unavailable";
}

export interface ResolvedProjects {
  /** Normalised relative paths, in declaration order, without duplicates. */
  projects: string[];
  refused: RefusedProject[];
}

function trimSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end--;
  return path.slice(0, end);
}

type ProjectRefusal = Omit<RefusedProject, "path">;
const OUTSIDE = { evidenceStatus: "unsupported", reason: "outside the repository" } as const;
const ROOT = {
  evidenceStatus: "unsupported",
  reason: "the root is the repo level, not a project",
} as const;

function checkDirectory(root: string, path: string): ProjectRefusal | undefined {
  const absolute = resolve(root, path);
  try {
    const resolved = realpathSync(absolute);
    const back = relative(realpathSync(root), resolved);
    if (back === "") return ROOT;
    if (leavesRepo(back)) return OUTSIDE;
    if (!statSync(resolved).isDirectory())
      return { evidenceStatus: "unsupported", reason: "not a directory" };
    accessSync(resolved, constants.R_OK | constants.X_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { evidenceStatus: "missing", reason: "does not exist" };
    return { evidenceStatus: "unavailable", reason: "could not read the project directory" };
  }
}

function judge(root: string, declared: string): { path: string } | ProjectRefusal {
  if (leavesRepo(declared)) return OUTSIDE;
  const path = trimSlashes(normalize(declared));
  if (path === "." || path === "") return ROOT;
  return checkDirectory(root, path) ?? { path: path.split("\\").join("/") };
}

/** The declared project paths that are real directories inside the repo, and the ones refused. */
export function resolveProjectPaths(
  root: string,
  declared: string[] | undefined,
): ResolvedProjects {
  const projects: string[] = [];
  const refused: RefusedProject[] = [];
  for (const d of declared ?? []) {
    const verdict = judge(join(root), d);
    if ("reason" in verdict) refused.push({ path: d, ...verdict });
    else if (!projects.includes(verdict.path)) projects.push(verdict.path);
  }
  return { projects, refused };
}
