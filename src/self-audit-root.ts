import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from this module or startDir to the nearest sandstream-kit package. */
export function resolveKitRoot(startDir?: string): string | null {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 64; depth++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
        if (pkg && pkg.name === "sandstream-kit") return dir;
      } catch {
        // Malformed package.json: keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
