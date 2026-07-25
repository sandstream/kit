/**
 * kit — ADR → gate. Turn the machine-readable part of an Architecture Decision
 * Record into a deterministic gate, cited back to the ADR ("why is this blocked?
 * → ADR-0007"). Design: kit-research/docs/research/adr-as-enforced-rule-design.md.
 *
 * kit does NOT interpret ADR prose (that needs an LLM — off-charter). It enforces
 * only an explicit ` ```toml kit-enforce ` block (parsed with the same smol-toml as
 * .kit.toml). Only `status: accepted` ADRs enforce; an accepted ADR with no enforce
 * block is surfaced as "documented, not enforced" — never silently green.
 *
 * Rule types (all deterministic, pure functions of the text inputs — no I/O):
 *   [[forbid_pattern]]  a regex that must NOT appear in matching files.
 *   [[require_pattern]] a regex that MUST appear in each matching file (absence gates).
 *   [[forbid_import]]   an import specifier (regex) a matching file must not import.
 *                       `transitive = true` also forbids reaching it through the
 *                       repo's relative-import graph; a relative import we cannot
 *                       resolve is surfaced as a *gap* (can't prove), never green.
 *                       `follow_packages = true` additionally walks ACROSS npm package
 *                       boundaries (a wrapper dependency that pulls the target in),
 *                       using an injected resolver so this module stays I/O-free.
 */
import { parse as parseToml } from "smol-toml";

export type AdrStatus = "proposed" | "accepted" | "superseded" | "deprecated" | "unknown";

export type AdrRuleType = "forbid-pattern" | "require-pattern" | "forbid-import";

/** A single deterministic enforce rule (discriminated on `type`). */
export type AdrRule =
  | {
      type: "forbid-pattern";
      /** Regex source that must NOT appear in matching files. */
      pattern: string;
      /** Glob of files the rule applies to. */
      paths: string;
      message?: string;
    }
  | {
      type: "require-pattern";
      /** Regex source that MUST appear at least once in each matching file. */
      pattern: string;
      paths: string;
      message?: string;
    }
  | {
      type: "forbid-import";
      /** Regex source matched against a module specifier a file imports. */
      import: string;
      paths: string;
      /** Also forbid reaching the target through the relative-import graph. */
      transitive?: boolean;
      /**
       * With `transitive`, also cross npm PACKAGE boundaries: follow a bare specifier into
       * `node_modules`, resolve the package's entry, and keep walking its imports. This is what
       * catches "web must never reach pg, even through a wrapper dependency". Opt-in because
       * the walk is far more expensive than the in-repo one, and bounded (depth + node cap).
       */
      followPackages?: boolean;
      message?: string;
    };

export interface Adr {
  id: string;
  title: string;
  status: AdrStatus;
  rules: AdrRule[];
  /** True when a ```toml kit-enforce block was present (even if it parsed to zero rules). */
  hasEnforceBlock: boolean;
}

export interface AdrViolation {
  adrId: string;
  file: string;
  line: number;
  rule: AdrRuleType;
  /** The offending (or missing / unresolved) detail — pattern source or specifier. */
  detail: string;
  message: string;
  /**
   * `violation` — the rule is broken (gates). `gap` — the rule could not be proven
   * (e.g. a transitive check hit an unresolvable relative import); fails closed but is
   * labeled distinctly so it is never presented as a clean pass (no false green).
   */
  kind: "violation" | "gap";
}

const STATUSES: AdrStatus[] = ["proposed", "accepted", "superseded", "deprecated"];

function scalar(frontmatter: string, key: string): string | undefined {
  const m = frontmatter.match(new RegExp(`^${key}:(.*)$`, "mi"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

function str(o: Record<string, unknown>, k: string): string | undefined {
  return typeof o[k] === "string" ? (o[k] as string) : undefined;
}

/**
 * Parse an ADR markdown file. Returns null when it has no `---` frontmatter or no `id`
 * (not an ADR). Never throws — a malformed enforce block yields `hasEnforceBlock: true`
 * with zero rules (surfaced, not a crash).
 */
export function parseAdr(raw: string): Adr | null {
  const text = raw.replace(/\r\n/g, "\n");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) return null;
  const [, frontmatter, body] = fm;
  const id = scalar(frontmatter, "id");
  if (!id) return null;
  const title = scalar(frontmatter, "title") ?? id;
  const rawStatus = (scalar(frontmatter, "status") ?? "unknown").toLowerCase();
  const status: AdrStatus = (STATUSES as string[]).includes(rawStatus)
    ? (rawStatus as AdrStatus)
    : "unknown";

  // A fenced ```toml kit-enforce block anywhere in the body.
  const block = body.match(/```toml\s+kit-enforce\s*\n([\s\S]*?)\n```/);
  let rules: AdrRule[] = [];
  const hasEnforceBlock = block !== null;
  if (block) {
    try {
      const parsed = parseToml(block[1]) as Record<string, unknown>;
      rules = [
        ...arr(parsed.forbid_pattern).map((r): AdrRule | null => {
          const pattern = str(r, "pattern");
          const paths = str(r, "paths");
          return pattern && paths
            ? { type: "forbid-pattern", pattern, paths, message: str(r, "message") }
            : null;
        }),
        ...arr(parsed.require_pattern).map((r): AdrRule | null => {
          const pattern = str(r, "pattern");
          const paths = str(r, "paths");
          return pattern && paths
            ? { type: "require-pattern", pattern, paths, message: str(r, "message") }
            : null;
        }),
        ...arr(parsed.forbid_import).map((r): AdrRule | null => {
          const imp = str(r, "import");
          const paths = str(r, "paths");
          return imp && paths
            ? {
                type: "forbid-import",
                import: imp,
                paths,
                transitive: r.transitive === true,
                followPackages: r.follow_packages === true,
                message: str(r, "message"),
              }
            : null;
        }),
      ].filter((r): r is AdrRule => r !== null);
    } catch {
      rules = []; // malformed TOML → zero rules, but hasEnforceBlock stays true (surfaced)
    }
  }
  return { id, title, status, rules, hasEnforceBlock };
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/** An accepted ADR that actually carries at least one enforceable rule. */
export function adrIsEnforced(adr: Adr): boolean {
  return adr.status === "accepted" && adr.rules.length > 0;
}

/** Minimal glob → RegExp (supports `**`, `*`, `?`). Anchored full-match. Deterministic. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` matches zero or more dirs
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

/** A module specifier imported by a file, with its 1-indexed source line. */
export interface ImportRef {
  specifier: string;
  line: number;
}

// A quoted module specifier used in an import / require / from / dynamic-import context.
const IMPORT_LINE = /(?:^|[^\w$])(?:import|require|from)\b[^'"\n]*['"]([^'"\n]+)['"]/;

/** Extract quoted module specifiers (ES import / re-export / require / dynamic import). */
export function extractImports(content: string): ImportRef[] {
  const out: ImportRef[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(IMPORT_LINE);
    if (m) out.push({ specifier: m[1], line: i + 1 });
  }
  return out;
}

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** POSIX-normalize a path (resolve `.`/`..`, no I/O). Used for relative-import resolution. */
function normalizePosix(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/**
 * Resolve a *relative* specifier (`./` `../`) against `fromFile` to a member of `fileSet`.
 * Returns null for bare specifiers (npm packages — intentionally graph leaves) and for
 * relative specifiers that resolve to nothing in the set (surfaced as a gap by the caller).
 */
export function resolveRelative(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null; // bare specifier = external leaf
  const base = normalizePosix(`${dirOf(fromFile)}/${specifier}`);
  // A `.js`/`.jsx`/`.mjs`/`.cjs` specifier resolves to the `.ts`-family source (ESM/TS
  // convention), so also try the extension-stripped base.
  const bases = [base];
  const jsExt = base.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsExt) bases.push(base.slice(0, -jsExt[0].length));
  for (const b of bases) {
    for (const ext of RESOLVE_EXTS) {
      if (fileSet.has(b + ext)) return b + ext;
    }
    for (const ext of RESOLVE_EXTS.slice(1)) {
      if (fileSet.has(`${b}/index${ext}`)) return `${b}/index${ext}`;
    }
  }
  return null;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith(".");
}

// Node builtins are true graph leaves: there is no user code behind `node:fs` to walk into,
// so an unfollowed builtin is NOT a gap. A rule that forbids one still gates on the direct
// match — the specifier is tested before we ever ask whether it is followable.
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "sqlite", "stream", "string_decoder", "sys", "test",
  "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]); // prettier-ignore

/** True for `node:*` and bare builtin specifiers (`fs`, `path/posix`, …). */
export function isBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier.split("/")[0]);
}

/**
 * Resolves what the pure in-repo graph cannot: an npm package's entry point and the files
 * inside it. INJECTED rather than imported so `evaluateAdr` stays a pure function of its
 * inputs; the fs-backed implementation lives in `src/commands/adr.ts`.
 */
export interface PackageResolver {
  /**
   * Resolve `specifier` (bare or relative) as imported from `fromFile` to a stable key, or
   * null when it cannot be resolved. Null is never a pass — the caller emits a `gap`.
   */
  resolve(fromFile: string, specifier: string): string | null;
  /** Source of a key previously returned by `resolve`, or null when unreadable. */
  read(key: string): string | null;
}

export interface EvaluateAdrOptions {
  /** Enables `follow_packages`. Without it such a rule degrades to the in-repo walk. */
  packages?: PackageResolver;
  /** Max npm package boundaries one walk may cross before it reports a gap. */
  maxPackageDepth?: number;
  /** Hard cap on distinct files one walk may visit before it reports a gap. */
  maxNodes?: number;
}

const DEFAULT_MAX_PACKAGE_DEPTH = 3;
const DEFAULT_MAX_NODES = 2000;

/**
 * Evaluate an accepted ADR's rules over the provided files. Pure — the caller supplies
 * `{ path, content }` for the repo; this never touches disk. A non-accepted ADR (or one
 * with no rules) yields no violations. Line numbers are 1-indexed.
 */
export function evaluateAdr(
  adr: Adr,
  files: { path: string; content: string }[],
  opts: EvaluateAdrOptions = {},
): AdrViolation[] {
  if (adr.status !== "accepted") return [];
  const out: AdrViolation[] = [];
  const fileSet = new Set(files.map((f) => f.path));
  // Import graph is built lazily and only once, only if a transitive rule needs it.
  let importCache: Map<string, ImportRef[]> | null = null;
  const importsOf = (path: string, content: string): ImportRef[] => {
    if (!importCache) importCache = new Map();
    let refs = importCache.get(path);
    if (!refs) {
      refs = extractImports(content);
      importCache.set(path, refs);
    }
    return refs;
  };
  const contentByPath = new Map(files.map((f) => [f.path, f.content] as const));
  const walkCtx: WalkCtx = {
    fileSet,
    importsOf,
    contentByPath,
    packages: opts.packages,
    maxPackageDepth: opts.maxPackageDepth ?? DEFAULT_MAX_PACKAGE_DEPTH,
    maxNodes: opts.maxNodes ?? DEFAULT_MAX_NODES,
  };

  for (const rule of adr.rules) {
    let globRe: RegExp;
    try {
      globRe = globToRegExp(rule.paths);
    } catch {
      continue;
    }
    const matched = files.filter((f) => globRe.test(f.path));

    if (rule.type === "forbid-pattern") {
      const matcher = safeRegExp(rule.pattern);
      if (!matcher) continue;
      for (const f of matched) {
        const idx = firstMatchingLine(f.content, matcher);
        if (idx >= 0)
          out.push(v(adr.id, f.path, idx + 1, "forbid-pattern", rule.pattern, "violation", rule.message ?? `forbidden by ${adr.id}: /${rule.pattern}/`)); // prettier-ignore
      }
    } else if (rule.type === "require-pattern") {
      const matcher = safeRegExp(rule.pattern);
      if (!matcher) continue;
      for (const f of matched) {
        if (firstMatchingLine(f.content, matcher) < 0)
          out.push(v(adr.id, f.path, 1, "require-pattern", rule.pattern, "violation", rule.message ?? `${adr.id} requires /${rule.pattern}/ — missing in this file`)); // prettier-ignore
      }
    } else if (rule.type === "forbid-import") {
      const matcher = safeRegExp(rule.import);
      if (!matcher) continue;
      for (const f of matched) {
        if (rule.transitive) {
          out.push(...evalTransitiveImport(adr.id, rule, f.path, matcher, walkCtx));
        } else {
          for (const ref of importsOf(f.path, f.content)) {
            if (matcher.test(ref.specifier))
              out.push(v(adr.id, f.path, ref.line, "forbid-import", ref.specifier, "violation", rule.message ?? `${adr.id} forbids importing "${ref.specifier}"`)); // prettier-ignore
          }
        }
      }
    }
  }
  return out;
}

function safeRegExp(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

function firstMatchingLine(content: string, matcher: RegExp): number {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) if (matcher.test(lines[i])) return i;
  return -1;
}

function v(
  adrId: string,
  file: string,
  line: number,
  rule: AdrRuleType,
  detail: string,
  kind: "violation" | "gap",
  message: string,
): AdrViolation {
  return { adrId, file, line, rule, detail, message, kind };
}

interface WalkCtx {
  fileSet: Set<string>;
  importsOf: (path: string, content: string) => ImportRef[];
  contentByPath: Map<string, string>;
  packages?: PackageResolver;
  maxPackageDepth: number;
  maxNodes: number;
}

/** Shorten a package key for the `via` chain: `…/node_modules/pg/index.js` → `pg/index.js`. */
function chainLabel(key: string): string {
  const i = key.lastIndexOf("node_modules/");
  return i < 0 ? key : key.slice(i + "node_modules/".length);
}

/** What one import edge is: a graph leaf, something we cannot prove, or a node to walk into. */
type WalkEdge =
  | { kind: "leaf" }
  | { kind: "gap"; why: string }
  | { kind: "follow"; resolved: string; depth: number };

/**
 * Classify one import edge. Bare specifiers are leaves unless the rule asked to cross package
 * boundaries AND a resolver was injected; builtins are always leaves. In-repo relative edges
 * stay on the pure fileSet resolver — everything else (bare specifiers, and any import made
 * from inside a package) goes through the injected one.
 */
function resolveEdge(
  ctx: WalkCtx,
  at: { ref: ImportRef; file: string; inRepo: boolean; depth: number; followPkgs: boolean },
): WalkEdge {
  const { ref, file, inRepo, depth, followPkgs } = at;
  const relative = isRelative(ref.specifier);
  if (!relative && (!followPkgs || isBuiltinSpecifier(ref.specifier))) return { kind: "leaf" };
  const nextDepth = relative ? depth : depth + 1;
  if (nextDepth > ctx.maxPackageDepth)
    return {
      kind: "gap",
      why: `package-walk depth ${ctx.maxPackageDepth} reached at "${ref.specifier}" in ${chainLabel(file)}`,
    };
  const resolved =
    inRepo && relative
      ? resolveRelative(file, ref.specifier, ctx.fileSet)
      : (ctx.packages?.resolve(file, ref.specifier) ?? null);
  return resolved === null
    ? { kind: "gap", why: `unresolved import "${ref.specifier}" in ${chainLabel(file)}` }
    : { kind: "follow", resolved, depth: nextDepth };
}

/**
 * Transitive forbid-import: BFS the import graph from `startFile`. A direct or reachable
 * import whose specifier matches → one violation (cited to the start file, with the chain in
 * the message). Anything we cannot follow to the end is surfaced as a `gap` (we cannot prove
 * the target is unreachable) — never silent green:
 *
 *   - an unresolvable relative import inside the repo
 *   - with `follow_packages`, a bare specifier that does not resolve in `node_modules`,
 *     a resolved module we cannot read, or a walk that hits the depth / node bound
 *
 * Without `follow_packages` (or without an injected resolver) bare specifiers stay leaves:
 * only a matching one gates, and an unmatched one is not a gap. Node builtins are always
 * leaves — there is no user code behind them to walk into.
 */
function evalTransitiveImport(
  adrId: string,
  rule: Extract<AdrRule, { type: "forbid-import" }>,
  startFile: string,
  matcher: RegExp,
  ctx: WalkCtx,
): AdrViolation[] {
  const followPkgs = rule.followPackages === true && ctx.packages !== undefined;
  const seen = new Set<string>([startFile]);
  const queue: { file: string; chain: string[]; depth: number }[] = [
    { file: startFile, chain: [startFile], depth: 0 },
  ];
  const gaps: AdrViolation[] = [];
  const gap = (specifier: string, file: string, line: number, why: string): void => {
    gaps.push(
      v(adrId, startFile, file === startFile ? line : 1, "forbid-import", specifier, "gap",
        `${adrId}: cannot prove — ${why}`), // prettier-ignore
    );
  };

  while (queue.length) {
    const { file, chain, depth } = queue.shift()!;
    const inRepo = ctx.fileSet.has(file);
    const content = inRepo ? ctx.contentByPath.get(file) : ctx.packages?.read(file);
    if (content === undefined || content === null) {
      // In-repo: the file was listed without content (nothing to walk). Out-of-repo: we
      // resolved a module and then could not read it — that edge is unproven, not clean.
      if (!inRepo) gap(file, file, 1, `unreadable module ${chainLabel(file)}`);
      continue;
    }
    for (const ref of ctx.importsOf(file, content)) {
      if (matcher.test(ref.specifier)) {
        const via = chain.length > 1 ? ` (via ${chain.map(chainLabel).join(" → ")})` : "";
        const line = file === startFile ? ref.line : 1;
        const base = rule.message ?? `${adrId} forbids reaching "${ref.specifier}"`;
        return [v(adrId, startFile, line, "forbid-import", ref.specifier, "violation", base + via)];
      }
      const edge = resolveEdge(ctx, { ref, file, inRepo, depth, followPkgs });
      if (edge.kind === "leaf") continue;
      if (edge.kind === "gap") {
        gap(ref.specifier, file, ref.line, edge.why);
        continue;
      }
      if (seen.has(edge.resolved)) continue;
      if (seen.size >= ctx.maxNodes) {
        gap(ref.specifier, file, ref.line,
          `import graph exceeded ${ctx.maxNodes} files — walk truncated at "${ref.specifier}"`); // prettier-ignore
        continue;
      }
      seen.add(edge.resolved);
      queue.push({ file: edge.resolved, chain: [...chain, edge.resolved], depth: edge.depth });
    }
  }
  // No violation found; surface at most one gap per start file (deduped) so an unresolved
  // edge downgrades the result from clean-green to "unproven" without flooding output.
  return gaps.length ? [gaps[0]] : [];
}
