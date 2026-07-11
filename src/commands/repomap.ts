/**
 * `kit map <path...>` — deterministic repo-map (Pillar 4). Builds a zero-LLM import graph of the repo
 * and prints the minimal relevant SLICE around the given seed files: the files connected to them
 * within `--depth` import hops (both directions), plus the external packages they pull in. Lets an
 * agent load a slice of a growing repo instead of the whole tree. `--json` emits the slice for a tool.
 *
 * Design: `kit-research/docs/research/pillar4-repo-map-5.0.md`. Deterministic and offline.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { walkSourceFiles } from "../source-walk.js";
import { buildImportGraph, relevantSlice, type FileImports, type RepoGraph } from "../repomap/graph.js";
import { parseImportSpecifiers, resolveImport, isRelativeSpecifier } from "../repomap/extract-ts.js";

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Walk `root`, parse imports, and build the whole-repo import graph (repo-relative posix ids). */
export function buildRepoGraph(root: string): RepoGraph {
  const absFiles = walkSourceFiles(root, { exts: EXTS, includeTests: true });
  const rel = (p: string) => relative(root, p).split("\\").join("/");
  const fileSet = new Set(absFiles.map(rel));

  const files: FileImports[] = [];
  for (const abs of absFiles) {
    const path = rel(abs);
    let source = "";
    try {
      source = readFileSync(abs, "utf-8");
    } catch {
      /* unreadable — treat as no imports */
    }
    const internal: string[] = [];
    const external: string[] = [];
    for (const spec of parseImportSpecifiers(source)) {
      if (isRelativeSpecifier(spec)) {
        const target = resolveImport(path, spec, fileSet);
        if (target) internal.push(target);
        // a relative spec that resolves to nothing is dropped (generated/missing) — never guessed
      } else {
        external.push(spec);
      }
    }
    files.push({ path, internal, external });
  }
  return buildImportGraph(files);
}

export async function cmdMap(): Promise<boolean> {
  const args = process.argv.slice(3);
  if (args.length === 0 || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(`${c.bold}kit map${c.reset} — deterministic repo-map: the relevant slice around a file\n`);
    console.log("Usage:");
    console.log("  kit map <path...>            Files connected to <path> within --depth import hops");
    console.log("  kit map <path> --depth 2     Widen the neighborhood (default 1)");
    console.log("  kit map <path> --json        Emit the slice as JSON (for an agent/tool)");
    console.log("\nExample:");
    console.log("  kit map src/exec-broker/broker.ts --depth 2");
    return args.length !== 0;
  }

  const json = hasFlag(args, "--json");
  const depthRaw = flagValue(process.argv, "--depth");
  const depth = depthRaw ? Math.max(0, Number.parseInt(depthRaw, 10) || 0) : 1;
  const root = process.cwd();
  // Positional seeds = args minus flags AND minus the value consumed by `--depth`.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--depth") {
      i++; // skip its value
      continue;
    }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  const seeds = positional.map((s) => relative(root, resolve(root, s)).split("\\").join("/"));

  const graph = buildRepoGraph(root);
  const known = new Set(graph.nodes.map((n) => n.id));
  const missing = seeds.filter((s) => !known.has(s));
  if (missing.length === seeds.length) {
    console.error(
      `${c.red}no seed matched a source file — check the path(s):${c.reset} ${missing.join(", ")}`,
    );
    return false;
  }

  const slice = relevantSlice(graph, seeds, depth);
  const files = slice.nodes.filter((n) => n.kind === "file");
  const externals = slice.nodes.filter((n) => n.kind === "external");

  if (json) {
    console.log(JSON.stringify({ seeds, depth, slice, missing }, null, 2));
    return true;
  }

  console.log(
    `${c.bold}Relevant slice${c.reset} ${c.dim}(depth ${depth}, from ${seeds.join(", ")})${c.reset}`,
  );
  console.log(`  ${c.bold}${files.length}${c.reset} files · ${externals.length} external packages`);
  for (const n of files) {
    const isSeed = seeds.includes(n.id);
    console.log(`  ${isSeed ? `${c.green}◆${c.reset}` : "·"} ${n.id}`);
  }
  if (externals.length) {
    console.log(`  ${c.dim}external:${c.reset} ${externals.map((n) => n.id).join(", ")}`);
  }
  if (missing.length) {
    console.log(`  ${c.yellow}unmatched seeds:${c.reset} ${missing.join(", ")}`);
  }
  return true;
}
