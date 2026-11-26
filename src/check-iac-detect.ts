import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * Where infrastructure code lives. `trivy config` reads a tree, so a root with no Dockerfile of its
 * own can still hold five of them in `docker/` and Terraform for three environments in `infra/`.
 * Looking only at the root reported "skip: nothing found" over exactly that, and a container that
 * ran as root stayed unseen in production for months.
 *
 * Bounded at three levels: this answers "is there anything to scan", it does not crawl a disk.
 */
const MAX_DEPTH = 3;

/** Directories whose contents are vendored, downloaded or build output, never the operator's own. */
const SKIPPED = new Set([
  "node_modules",
  ".git",
  ".terraform",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".venv",
  "venv",
  "coverage",
]);

const COMPOSE = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

/**
 * The Dockerfile names trivy reads: `Dockerfile`, `Dockerfile.<x>`, `<x>.Dockerfile` and
 * `Containerfile`. A tree whose only images were `containers/*.Dockerfile` skipped both trivy rows
 * with "no Dockerfile found" (kit-research `decepticon-vs-kit`).
 */
export function isDockerfileName(name: string): boolean {
  return /^(?:Dockerfile(?:\..+)?|.+\.Dockerfile|Containerfile)$/.test(name);
}

function isIacFile(name: string): boolean {
  return isDockerfileName(name) || name.endsWith(".tf") || COMPOSE.includes(name);
}

/** Dockerfile, Compose and Terraform paths within the bounded project discovery. */
export async function findIacFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isFile() && isIacFile(entry.name)) found.push(path);
      if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED.has(entry.name))
        await walk(join(dir, entry.name), path, depth + 1);
    }
  };
  await walk(root, "", 0);
  return found.sort();
}

/** Dockerfile paths within the same bounded discovery, so a root without one is not "none". */
export async function findDockerfiles(root: string): Promise<string[]> {
  return (await findIacFiles(root)).filter((path) => isDockerfileName(posix.basename(path)));
}

/** Directories (relative, "." for the root) that hold discovered IaC. */
export async function findIac(root: string): Promise<string[]> {
  return [...new Set((await findIacFiles(root)).map((path) => posix.dirname(path)))].sort();
}
