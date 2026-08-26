/**
 * `kit map <path...>` — deterministic repo-map (Pillar 4). Builds a zero-LLM import graph of the repo
 * and prints the minimal relevant SLICE around the given seed files: the files connected to them
 * within `--depth` import hops (both directions), plus the external packages they pull in. Lets an
 * agent load a slice of a growing repo instead of the whole tree. `--json` emits the slice for a tool.
 *
 * Deterministic and offline.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { walkSourceFiles } from "../source-walk.js";
import {
  buildImportGraph,
  relevantSlice,
  budgetSlice,
  type FileImports,
  type RepoGraph,
} from "../repomap/graph.js";
import {
  parseImportSpecifiers,
  resolveImport,
  isRelativeSpecifier,
} from "../repomap/extract-ts.js";
import { parsePythonImports, resolvePythonImport } from "../repomap/extract-py.js";
import {
  parseCodeowners,
  ownerFor,
  topAuthor,
  CODEOWNERS_PATHS,
  type CodeownersRule,
} from "../repomap/ownership.js";
import {
  parseCoChangeLog,
  coChangeCounts,
  topCoChanged,
  COCHANGE_SEP,
  type CoChange,
} from "../repomap/cochange.js";

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];

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
    files.push({ path, ...resolveImports(path, source, fileSet) });
  }
  return buildImportGraph(files);
}

/** Resolve one file's imports to in-repo targets + external specifiers, dispatched by language. */
function resolveImports(
  path: string,
  source: string,
  fileSet: Set<string>,
): { internal: string[]; external: string[] } {
  const internal: string[] = [];
  const external: string[] = [];
  if (path.endsWith(".py")) {
    // Python: resolve dotted/relative imports to repo files; unresolved → external (never guessed).
    for (const tok of parsePythonImports(source)) {
      const target = resolvePythonImport(path, tok, fileSet);
      if (target) internal.push(target);
      else external.push(tok);
    }
  } else {
    for (const spec of parseImportSpecifiers(source)) {
      if (!isRelativeSpecifier(spec)) {
        external.push(spec);
        continue;
      }
      const target = resolveImport(path, spec, fileSet);
      if (target) internal.push(target); // unresolved relative spec is dropped — never guessed
    }
  }
  return { internal, external };
}

/** Load CODEOWNERS rules from the first standard location that exists (empty if none). */
function loadCodeowners(root: string): CodeownersRule[] {
  for (const rel of CODEOWNERS_PATHS) {
    try {
      return parseCodeowners(readFileSync(resolve(root, rel), "utf-8"));
    } catch {
      /* not here — try the next location */
    }
  }
  return [];
}

export async function cmdMap(): Promise<boolean> {
  const args = process.argv.slice(3);
  if (args.length === 0 || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(
      `${c.bold}kit map${c.reset} — deterministic repo-map: the relevant slice around a file\n`,
    );
    console.log("Usage:");
    console.log(
      "  kit map <path...>            Files connected to <path> within --depth import hops",
    );
    console.log("  kit map <path> --depth 2     Widen the neighborhood (default 1)");
    console.log(
      "  kit map <path> --budget 20   Keep only the 20 nearest files (drops are logged, never silent)",
    );
    console.log(
      "  kit map <path> --co-change   Add files that historically change WITH the seed (git history)",
    );
    console.log("  kit map <path> --json        Emit the slice as JSON (for an agent/tool)");
    console.log("\nExample:");
    console.log("  kit map src/exec-broker/broker.ts --depth 2 --budget 25 --co-change");
    return args.length !== 0;
  }

  const json = hasFlag(args, "--json");
  const wantCoChange = hasFlag(args, "--co-change");
  const depthRaw = flagValue(process.argv, "--depth");
  const depth = depthRaw ? Math.max(0, Number.parseInt(depthRaw, 10) || 0) : 1;
  const budgetRaw = flagValue(process.argv, "--budget");
  const budget = budgetRaw ? Math.max(0, Number.parseInt(budgetRaw, 10) || 0) : 0;
  const root = process.cwd();
  // Positional seeds = args minus flags AND minus the values consumed by `--depth` / `--budget`.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--depth" || a === "--budget") {
      i++; // skip its value
      continue;
    }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  const seeds = positional.map((s) => relative(root, resolve(root, s)).split("\\").join("/"));

  const report = mapReport(root, seeds, { depth, budget, coChange: wantCoChange });
  if (report.missing.length === seeds.length) {
    console.error(
      `${c.red}no seed matched a source file — check the path(s):${c.reset} ${report.missing.join(", ")}`,
    );
    return false;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return true;
  }

  printReadableSlice({
    slice: report.slice,
    seeds,
    depth,
    budget,
    droppedFiles: report.dropped,
    missing: report.missing,
    owners: report.owners,
    source: report.ownerSource,
    coChanged: report.coChanged ?? {},
  });
  return true;
}

export interface MapReport {
  seeds: string[];
  depth: number;
  budget: number | null;
  slice: RepoGraph;
  owners: Record<string, string[]>;
  ownerSource: "codeowners" | "git" | "none";
  coChanged?: Record<string, CoChange[]>;
  dropped: string[];
  missing: string[];
}

/**
 * The shared repo-map core behind BOTH `kit map` (CLI) and the `kit_map` MCP tool — one function so
 * the two surfaces can never disagree (surface-unification doctrine). Deterministic; git usage in
 * ownership/co-change is bounded and fail-closed. `seeds` are repo-relative posix paths.
 */
export function mapReport(
  root: string,
  seeds: string[],
  opts: { depth: number; budget: number; coChange: boolean },
): MapReport {
  const graph = buildRepoGraph(root);
  const known = new Set(graph.nodes.map((n) => n.id));
  const missing = seeds.filter((s) => !known.has(s));

  const full = relevantSlice(graph, seeds, opts.depth);
  const { kept, dropped } = budgetSlice(full, seeds, opts.budget);
  const keptIds = new Set(kept.map((n) => n.id));
  const slice: RepoGraph =
    opts.budget > 0
      ? { nodes: kept, edges: full.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)) }
      : full;
  const droppedFiles = dropped.filter((n) => n.kind === "file").map((n) => n.id);

  const { owners, source } = computeOwners(root, slice);
  const coChanged = opts.coChange ? computeCoChange(root, seeds) : undefined;

  return {
    seeds,
    depth: opts.depth,
    budget: opts.budget || null,
    slice,
    owners,
    ownerSource: source,
    coChanged,
    dropped: droppedFiles,
    missing,
  };
}

/** Commits to scan for co-change coupling — bounds the single `git log` call on a deep history. */
const COCHANGE_COMMITS = 1500;

/**
 * Top co-changed files per seed from git history. One bounded `git log --name-only` call; parsed and
 * counted purely. Fail-closed: git absent/errored → `{}` (no coupling claimed, never guessed).
 */
function computeCoChange(root: string, seeds: string[]): Record<string, CoChange[]> {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      [
        "-C",
        root,
        "log",
        `-n${COCHANGE_COMMITS}`,
        "--no-merges",
        "--name-only",
        `--format=${COCHANGE_SEP}%H`,
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch {
    return {};
  }
  const counts = coChangeCounts(parseCoChangeLog(raw));
  const out: Record<string, CoChange[]> = {};
  for (const seed of seeds) {
    const top = topCoChanged(counts, seed);
    if (top.length) out[seed] = top;
  }
  return out;
}

/** Max files to git-blame for the ownership fallback — bounds per-file git calls on a big slice. */
const BLAME_CAP = 60;

/**
 * Owners for the slice's files. Prefers a committed CODEOWNERS (deterministic, no I/O beyond the
 * file read). Without one, falls back to each file's git-blame top-author (bounded by BLAME_CAP,
 * fail-closed: git absent/errored → no owner, never guessed). Returns the source so the UI can say so.
 */
function computeOwners(
  root: string,
  slice: RepoGraph,
): { owners: Record<string, string[]>; source: "codeowners" | "git" | "none" } {
  const files = slice.nodes.filter((n) => n.kind === "file");
  const owners: Record<string, string[]> = {};

  const rules = loadCodeowners(root);
  if (rules.length) {
    for (const n of files) {
      const who = ownerFor(n.id, rules);
      if (who.length) owners[n.id] = who;
    }
    return { owners, source: "codeowners" };
  }

  let blamed = false;
  for (const n of files.slice(0, BLAME_CAP)) {
    const author = gitTopAuthor(root, n.id);
    if (author) {
      owners[n.id] = [`${author} (git)`];
      blamed = true;
    }
  }
  return { owners, source: blamed ? "git" : "none" };
}

/** A file's git-blame top-author, or null if git is absent/errors (fail-closed — never guessed). */
function gitTopAuthor(root: string, file: string): string | null {
  try {
    const out = execFileSync("git", ["-C", root, "log", "--format=%an", "--", file], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return topAuthor(out.split("\n"));
  } catch {
    return null;
  }
}

/** Human-readable render of a slice (the non-`--json` path). Kept separate so `cmdMap` stays lean. */
function printReadableSlice(o: {
  slice: RepoGraph;
  seeds: string[];
  depth: number;
  budget: number;
  droppedFiles: string[];
  missing: string[];
  owners: Record<string, string[]>;
  source: "codeowners" | "git" | "none";
  coChanged: Record<string, CoChange[]>;
}): void {
  const files = o.slice.nodes.filter((n) => n.kind === "file");
  const externals = o.slice.nodes.filter((n) => n.kind === "external");
  const ownerNote =
    o.source === "codeowners"
      ? ` ${c.dim}· owners from CODEOWNERS${c.reset}`
      : o.source === "git"
        ? ` ${c.dim}· owners from git blame${c.reset}`
        : "";
  console.log(
    `${c.bold}Relevant slice${c.reset} ${c.dim}(depth ${o.depth}, from ${o.seeds.join(", ")})${c.reset}${ownerNote}`,
  );
  console.log(`  ${c.bold}${files.length}${c.reset} files · ${externals.length} external packages`);
  for (const n of files) {
    const isSeed = o.seeds.includes(n.id);
    const who = o.owners[n.id];
    const ownerTag = who?.length ? ` ${c.dim}${who.join(" ")}${c.reset}` : "";
    console.log(`  ${isSeed ? `${c.green}◆${c.reset}` : "·"} ${n.id}${ownerTag}`);
  }
  if (externals.length) {
    console.log(`  ${c.dim}external:${c.reset} ${externals.map((n) => n.id).join(", ")}`);
  }
  if (o.droppedFiles.length) {
    const shown = o.droppedFiles.slice(0, 15);
    const more = o.droppedFiles.length - shown.length;
    const tail = more > 0 ? `, …and ${more} more (use --json for the full list)` : "";
    console.log(
      `  ${c.yellow}${o.droppedFiles.length} file(s) dropped to fit --budget ${o.budget}:${c.reset} ${shown.join(", ")}${tail}`,
    );
  }
  for (const seed of o.seeds) {
    const co = o.coChanged[seed];
    if (co?.length) {
      const list = co.map((x) => `${x.file} (${x.count})`).join(", ");
      console.log(`  ${c.dim}co-changes with ${seed}:${c.reset} ${list}`);
    }
  }
  if (o.missing.length) {
    console.log(`  ${c.yellow}unmatched seeds:${c.reset} ${o.missing.join(", ")}`);
  }
}
