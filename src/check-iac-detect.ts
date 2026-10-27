import { readdir } from "node:fs/promises";
import { join } from "node:path";

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

function isIacFile(name: string): boolean {
  return (
    name === "Dockerfile" ||
    name.startsWith("Dockerfile.") ||
    name.endsWith(".tf") ||
    COMPOSE.includes(name)
  );
}

/** Directories (relative, "." for the root) that hold a Dockerfile, a compose file or Terraform. */
export async function findIac(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && isIacFile(e.name))) found.push(rel || ".");
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory() || SKIPPED.has(e.name)) continue;
      await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  await walk(root, "", 0);
  return found.sort();
}
