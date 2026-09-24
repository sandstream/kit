/**
 * Pure import-graph substrate for ADR enforcement. This module owns specifier extraction,
 * relative resolution, builtin classification, and fail-closed transitive walks. Filesystem
 * access remains injected through PackageResolver.
 */

interface TransitiveImportRule {
  followPackages?: boolean;
  message?: string;
}

interface ImportGraphFinding {
  adrId: string;
  file: string;
  line: number;
  rule: "forbid-import";
  detail: string;
  message: string;
  kind: "violation" | "gap";
}

/** A module specifier imported by a file, with its 1-indexed source line. */
export interface ImportRef {
  specifier: string;
  line: number;
}

// A quoted module specifier used in an import / require / from / dynamic-import context.
const IMPORT_LINE = new RegExp(
  "(?:^|[^\\w$])(?:import|require|from)\\b[^'\"\\n]*['\"]([^'\"\\n]+)['\"]",
);

/** Extract quoted module specifiers (ES import / re-export / require / dynamic import). */
export function extractImports(content: string): ImportRef[] {
  const out: ImportRef[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(IMPORT_LINE);
    if (match) out.push({ specifier: match[1], line: i + 1 });
  }
  return out;
}

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** POSIX-normalize a path (resolve `.`/`..`, no I/O). Used for relative-import resolution. */
function normalizePosix(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const segment of parts) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/**
 * Resolve a *relative* specifier (`./` `../`) against `fromFile` to a member of `fileSet`.
 * Returns null for bare specifiers and relative specifiers that resolve to nothing in the set.
 */
export function resolveRelative(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = normalizePosix(`${dirOf(fromFile)}/${specifier}`);
  // A compiled JS specifier can point to its TypeScript source.
  const bases = [base];
  const jsExt = base.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsExt) bases.push(base.slice(0, -jsExt[0].length));
  for (const candidate of bases) {
    for (const ext of RESOLVE_EXTS) {
      if (fileSet.has(candidate + ext)) return candidate + ext;
    }
    for (const ext of RESOLVE_EXTS.slice(1)) {
      if (fileSet.has(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
    }
  }
  return null;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith(".");
}

// Builtins are graph leaves: no user code exists behind them to walk into.
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "sqlite", "stream", "string_decoder", "sys", "test",
  "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]); // prettier-ignore

/** True for `node:*` and bare builtin specifiers (`fs`, `path/posix`, ...). */
export function isBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier.split("/")[0]);
}

/** Resolves package imports without coupling the pure graph to filesystem I/O. */
export interface PackageResolver {
  /** Resolve a specifier from a file to a stable key, or null when unresolved. */
  resolve(fromFile: string, specifier: string): string | null;
  /** Source for a resolved key, or null when unreadable. */
  read(key: string): string | null;
}

/** Inputs shared by direct and transitive import-rule evaluation. */
export interface AdrImportWalkContext {
  fileSet: Set<string>;
  importsOf: (path: string, content: string) => ImportRef[];
  contentByPath: Map<string, string>;
  packages?: PackageResolver;
  maxPackageDepth: number;
  maxNodes: number;
}

/** Shorten a package key for a `via` chain. */
function chainLabel(key: string): string {
  const index = key.lastIndexOf("node_modules/");
  return index < 0 ? key : key.slice(index + "node_modules/".length);
}

type WalkEdge =
  | { kind: "leaf" }
  | { kind: "gap"; why: string }
  | { kind: "follow"; resolved: string; depth: number };

/** Classify an import as a graph leaf, an unproven gap, or a followable node. */
function resolveEdge(
  ctx: AdrImportWalkContext,
  at: { ref: ImportRef; file: string; inRepo: boolean; depth: number; followPkgs: boolean },
): WalkEdge {
  const { ref, file, inRepo, depth, followPkgs } = at;
  const relative = isRelative(ref.specifier);
  if (!relative && (!followPkgs || isBuiltinSpecifier(ref.specifier))) return { kind: "leaf" };
  const nextDepth = relative ? depth : depth + 1;
  if (nextDepth > ctx.maxPackageDepth) {
    return {
      kind: "gap",
      why: `package-walk depth ${ctx.maxPackageDepth} reached at "${ref.specifier}" in ${chainLabel(file)}`,
    };
  }
  const resolved =
    inRepo && relative
      ? resolveRelative(file, ref.specifier, ctx.fileSet)
      : (ctx.packages?.resolve(file, ref.specifier) ?? null);
  return resolved === null
    ? { kind: "gap", why: `unresolved import "${ref.specifier}" in ${chainLabel(file)}` }
    : { kind: "follow", resolved, depth: nextDepth };
}

type WalkNode = { file: string; chain: string[]; depth: number };

interface TransitiveWalk {
  adrId: string;
  rule: TransitiveImportRule;
  startFile: string;
  matcher: RegExp;
  ctx: AdrImportWalkContext;
  followPackages: boolean;
  seen: Set<string>;
  queue: WalkNode[];
  gaps: ImportGraphFinding[];
}

function createTransitiveWalk(
  adrId: string,
  rule: TransitiveImportRule,
  startFile: string,
  matcher: RegExp,
  ctx: AdrImportWalkContext,
): TransitiveWalk {
  return {
    adrId,
    rule,
    startFile,
    matcher,
    ctx,
    followPackages: rule.followPackages === true && ctx.packages !== undefined,
    seen: new Set([startFile]),
    queue: [{ file: startFile, chain: [startFile], depth: 0 }],
    gaps: [],
  };
}

function recordTransitiveGap(
  walk: TransitiveWalk,
  specifier: string,
  file: string,
  line: number,
  why: string,
): void {
  walk.gaps.push({
    adrId: walk.adrId,
    file: walk.startFile,
    line: file === walk.startFile ? line : 1,
    rule: "forbid-import",
    detail: specifier,
    kind: "gap",
    message: `${walk.adrId}: cannot prove — ${why}`,
  });
}

function transitiveViolation(
  walk: TransitiveWalk,
  node: WalkNode,
  ref: ImportRef,
): ImportGraphFinding {
  const via = node.chain.length > 1 ? ` (via ${node.chain.map(chainLabel).join(" → ")})` : "";
  return {
    adrId: walk.adrId,
    file: walk.startFile,
    line: node.file === walk.startFile ? ref.line : 1,
    rule: "forbid-import",
    detail: ref.specifier,
    kind: "violation",
    message: (walk.rule.message ?? `${walk.adrId} forbids reaching "${ref.specifier}"`) + via,
  };
}

function followWalkEdge(
  walk: TransitiveWalk,
  node: WalkNode,
  ref: ImportRef,
  inRepo: boolean,
): void {
  const edge = resolveEdge(walk.ctx, {
    ref,
    file: node.file,
    inRepo,
    depth: node.depth,
    followPkgs: walk.followPackages,
  });
  if (edge.kind === "leaf") return;
  if (edge.kind === "gap") {
    recordTransitiveGap(walk, ref.specifier, node.file, ref.line, edge.why);
    return;
  }
  if (walk.seen.has(edge.resolved)) return;
  if (walk.seen.size >= walk.ctx.maxNodes) {
    recordTransitiveGap(
      walk,
      ref.specifier,
      node.file,
      ref.line,
      `import graph exceeded ${walk.ctx.maxNodes} files — walk truncated at "${ref.specifier}"`,
    );
    return;
  }
  walk.seen.add(edge.resolved);
  walk.queue.push({
    file: edge.resolved,
    chain: [...node.chain, edge.resolved],
    depth: edge.depth,
  });
}

function inspectWalkNode(
  walk: TransitiveWalk,
  node: WalkNode,
  content: string,
  inRepo: boolean,
): ImportGraphFinding | null {
  for (const ref of walk.ctx.importsOf(node.file, content)) {
    if (walk.matcher.test(ref.specifier)) return transitiveViolation(walk, node, ref);
    followWalkEdge(walk, node, ref, inRepo);
  }
  return null;
}

/**
 * BFS a transitive forbid-import rule. A matching reachable import returns a violation;
 * unresolved, unreadable, or bounded edges return one fail-closed gap when no violation wins.
 */
export function evaluateTransitiveImport(
  adrId: string,
  rule: TransitiveImportRule,
  startFile: string,
  matcher: RegExp,
  ctx: AdrImportWalkContext,
): ImportGraphFinding[] {
  const walk = createTransitiveWalk(adrId, rule, startFile, matcher, ctx);
  while (walk.queue.length) {
    const node = walk.queue.shift()!;
    const inRepo = ctx.fileSet.has(node.file);
    const content = inRepo ? ctx.contentByPath.get(node.file) : ctx.packages?.read(node.file);
    if (content === undefined || content === null) {
      if (!inRepo) {
        recordTransitiveGap(
          walk,
          node.file,
          node.file,
          1,
          `unreadable module ${chainLabel(node.file)}`,
        );
      }
      continue;
    }
    const violation = inspectWalkNode(walk, node, content, inRepo);
    if (violation) return [violation];
  }
  return walk.gaps.length ? [walk.gaps[0]] : [];
}
