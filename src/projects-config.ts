import { existsSync, realpathSync, statSync } from "node:fs";
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

function judge(root: string, declared: string): { path: string } | { reason: string } {
  if (leavesRepo(declared)) return { reason: "outside the repository" };
  const path = trimSlashes(normalize(declared));
  if (path === "." || path === "") return { reason: "the root is the repo level, not a project" };
  const abs = resolve(root, path);
  if (!existsSync(abs)) return { reason: "does not exist" };
  if (!statSync(abs).isDirectory()) return { reason: "not a directory" };
  const back = relative(realpathSync(root), realpathSync(abs));
  if (back.startsWith("..") || isAbsolute(back)) return { reason: "outside the repository" };
  return { path: path.split("\\").join("/") };
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
    if ("reason" in verdict) refused.push({ path: d, reason: verdict.reason });
    else if (!projects.includes(verdict.path)) projects.push(verdict.path);
  }
  return { projects, refused };
}
