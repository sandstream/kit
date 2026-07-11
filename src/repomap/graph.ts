/**
 * Repo-map — pure code-graph core (Pillar 4, deterministic / zero-LLM).
 *
 * Design: `kit-research/docs/research/pillar4-repo-map-5.0.md`. This module is the extraction-agnostic
 * graph half: given files and their resolved import targets, build an import graph and compute the
 * minimal relevant SLICE around a set of seed files — so an agent loads a slice of a growing repo,
 * not the whole tree. Pure and deterministic (sorted output); no I/O, no model, no embeddings.
 */

export type RepoNodeKind = "file" | "external";

export interface RepoNode {
  /** Repo-relative path for a `file` node; the bare specifier for an `external` (npm/builtin) node. */
  id: string;
  kind: RepoNodeKind;
}

export interface RepoEdge {
  from: string; // importer file id
  to: string; // imported node id (file or external)
  kind: "imports";
}

export interface RepoGraph {
  nodes: RepoNode[];
  edges: RepoEdge[];
}

/** One file's resolved imports: in-repo targets (file ids) and external specifiers. */
export interface FileImports {
  path: string; // repo-relative
  internal: string[]; // resolved repo-relative file ids
  external: string[]; // bare specifiers (npm/builtin) — kept as nodes, never traversed
}

const byId = (a: RepoNode, b: RepoNode) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byEdge = (a: RepoEdge, b: RepoEdge) =>
  a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0;

/**
 * Build a deterministic import graph. Every file is a `file` node; each external specifier is an
 * `external` node. Edges are `imports` (importer → imported). Output is sorted for reproducibility.
 */
export function buildImportGraph(files: FileImports[]): RepoGraph {
  const nodes = new Map<string, RepoNode>();
  const edges: RepoEdge[] = [];
  const seen = new Set<string>();

  const addEdge = (from: string, to: string) => {
    const key = from + " -> " + to;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind: "imports" });
  };

  for (const f of files) nodes.set(f.path, { id: f.path, kind: "file" });
  for (const f of files) {
    for (const dep of f.internal) {
      if (!nodes.has(dep)) nodes.set(dep, { id: dep, kind: "file" }); // referenced but not walked
      addEdge(f.path, dep);
    }
    for (const ext of f.external) {
      if (!nodes.has(ext)) nodes.set(ext, { id: ext, kind: "external" });
      addEdge(f.path, ext);
    }
  }
  return { nodes: [...nodes.values()].sort(byId), edges: edges.sort(byEdge) };
}

/**
 * The relevant slice: every node within `depth` import hops of any seed, treating edges as
 * UNDIRECTED (so the slice includes both what a seed imports AND what imports it — the neighborhood
 * an agent actually needs), plus every edge among the collected nodes. `external` nodes are included
 * when incident but never expanded past (they have no outgoing edges). Deterministic. Pure.
 */
export function relevantSlice(graph: RepoGraph, seeds: string[], depth: number): RepoGraph {
  const known = new Set(graph.nodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const n of graph.nodes) adj.set(n.id, new Set());
  for (const e of graph.edges) {
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
  }

  const keep = new Set<string>();
  let frontier = new Set<string>();
  for (const s of seeds) {
    if (known.has(s)) {
      keep.add(s);
      frontier.add(s);
    }
  }

  for (let d = 0; d < Math.max(0, depth); d++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!keep.has(nb)) {
          keep.add(nb);
          next.add(nb);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { nodes, edges };
}

/**
 * BFS distance (undirected import hops) from the nearest seed to every reachable node in `graph`.
 * Seeds are distance 0; unreachable nodes are absent from the map. Pure and deterministic.
 */
export function distancesFromSeeds(graph: RepoGraph, seeds: string[]): Map<string, number> {
  const known = new Set(graph.nodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const n of graph.nodes) adj.set(n.id, new Set());
  for (const e of graph.edges) {
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
  }
  const dist = new Map<string, number>();
  let frontier: string[] = [];
  for (const s of seeds) {
    if (known.has(s) && !dist.has(s)) {
      dist.set(s, 0);
      frontier.push(s);
    }
  }
  let d = 0;
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!dist.has(nb)) {
          dist.set(nb, d + 1);
          next.push(nb);
        }
      }
    }
    d++;
    frontier = next;
  }
  return dist;
}

export interface BudgetResult {
  kept: RepoNode[];
  dropped: RepoNode[];
}

/**
 * Rank a slice's FILE nodes by relevance — nearest-to-a-seed first (BFS distance), then path for a
 * stable tie-break — and keep at most `maxFiles`, returning the rest as `dropped` (never silently
 * truncated: the caller logs the drop). `external` nodes are metadata, not budgeted: every external
 * incident to a kept file is kept. `maxFiles <= 0` keeps everything. Pure and deterministic.
 */
export function budgetSlice(slice: RepoGraph, seeds: string[], maxFiles: number): BudgetResult {
  const files = slice.nodes.filter((n) => n.kind === "file");
  const externals = slice.nodes.filter((n) => n.kind === "external");
  if (maxFiles <= 0 || files.length <= maxFiles) {
    return { kept: slice.nodes, dropped: [] };
  }

  const dist = distancesFromSeeds(slice, seeds);
  const rank = (n: RepoNode) => dist.get(n.id) ?? Number.MAX_SAFE_INTEGER;
  const ranked = [...files].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
  const keptFiles = ranked.slice(0, maxFiles);
  const droppedFiles = ranked.slice(maxFiles);

  const keptIds = new Set(keptFiles.map((n) => n.id));
  const keptExternals = externals.filter((ext) =>
    slice.edges.some((e) => e.to === ext.id && keptIds.has(e.from)),
  );

  const byId = (a: RepoNode, b: RepoNode) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    kept: [...keptFiles, ...keptExternals].sort(byId),
    dropped: droppedFiles.sort(byId),
  };
}
