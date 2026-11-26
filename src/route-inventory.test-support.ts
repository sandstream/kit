import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** An ES import line for a package, built so the fixture itself names no AI SDK import. */
export function sdkLine(pkg: string, name = "x"): string {
  return ["imp", "ort ", name, " fr", "om ", JSON.stringify(pkg), ";"].join("");
}

/** A temporary project with the given files (paths `/`-separated). */
export function routeTree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-routes-"));
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(dir, ...rel.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
