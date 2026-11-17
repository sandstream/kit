/**
 * The review gate's *wide* lane: a source module that many other modules import.
 *
 * The protected-path list names what KIND of file is risky. It cannot say how many files depend on
 * one: `src/config.ts` had 132 importers and was approved on green checks like a file nothing
 * imports (kit-research loops-and-graphs-vs-kit). This counts importers from the import graph of
 * the checkout the gate runs on (the default branch, so a pull request cannot shrink the count),
 * and a changed module at or above the threshold goes to the owner, as a protected path does.
 *
 * Deterministic and text-level: relative imports in non-test `src/**` TypeScript, resolved with
 * the repo map's resolver. No model.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseImportSpecifiers, resolveImport } from "./repomap/extract-ts.js";

/** Importers at or above which a changed module needs the owner. */
export const WIDE_IMPORTERS = 20;

const isTest = (rel: string) => /\.test(-support)?\.ts$/.test(rel);

function sourceFiles(root: string, dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(root, rel));
    else if (entry.isFile() && rel.endsWith(".ts") && !rel.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

/** How many non-test modules import each module, keyed by repo-relative posix path. */
export function importerCounts(root: string): Map<string, number> {
  const files = sourceFiles(root);
  const fileSet = new Set(files);
  const counts = new Map<string, number>();
  for (const from of files) {
    if (isTest(from)) continue;
    const targets = new Set<string>();
    for (const spec of parseImportSpecifiers(readFileSync(join(root, from), "utf-8"))) {
      const to = resolveImport(from, spec, fileSet);
      if (to && to !== from) targets.add(to);
    }
    for (const to of targets) counts.set(to, (counts.get(to) ?? 0) + 1);
  }
  return counts;
}

/** The changed paths that are wide, widest first. Pure. */
export function widePaths(
  paths: readonly string[],
  counts: ReadonlyMap<string, number>,
  threshold = WIDE_IMPORTERS,
): { path: string; importers: number }[] {
  return [...new Set(paths)]
    .map((path) => ({ path, importers: counts.get(path) ?? 0 }))
    .filter((p) => p.importers >= threshold)
    .sort((a, b) => b.importers - a.importers || a.path.localeCompare(b.path));
}
