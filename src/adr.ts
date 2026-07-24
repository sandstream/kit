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

/**
 * Evaluate an accepted ADR's rules over the provided files. Pure — the caller supplies
 * `{ path, content }` for the repo; this never touches disk. A non-accepted ADR (or one
 * with no rules) yields no violations. Line numbers are 1-indexed.
 */
export function evaluateAdr(adr: Adr, files: { path: string; content: string }[]): AdrViolation[] {
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
          out.push(
            ...evalTransitiveImport(
              adr.id,
              rule,
              f.path,
              matcher,
              fileSet,
              importsOf,
              contentByPath,
            ),
          );
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

/**
 * Transitive forbid-import: BFS the relative-import graph from `startFile`. A direct or
 * reachable import whose specifier matches → one violation (cited to the start file, with
 * the chain in the message). Any relative import that does not resolve within the repo is
 * surfaced as a `gap` (we cannot prove the target is unreachable) — never silent green.
 * Bare specifiers are leaves: only the matched one gates, unmatched ones are not gaps.
 */
function evalTransitiveImport(
  adrId: string,
  rule: Extract<AdrRule, { type: "forbid-import" }>,
  startFile: string,
  matcher: RegExp,
  fileSet: Set<string>,
  importsOf: (path: string, content: string) => ImportRef[],
  contentByPath: Map<string, string>,
): AdrViolation[] {
  const seen = new Set<string>([startFile]);
  const queue: { file: string; chain: string[] }[] = [{ file: startFile, chain: [startFile] }];
  const gaps: AdrViolation[] = [];
  while (queue.length) {
    const { file, chain } = queue.shift()!;
    const content = contentByPath.get(file);
    if (content === undefined) continue;
    for (const ref of importsOf(file, content)) {
      if (matcher.test(ref.specifier)) {
        const via = chain.length > 1 ? ` (via ${chain.join(" → ")})` : "";
        const line = file === startFile ? ref.line : 1;
        const base = rule.message ?? `${adrId} forbids reaching "${ref.specifier}"`;
        return [v(adrId, startFile, line, "forbid-import", ref.specifier, "violation", base + via)];
      }
      if (isRelative(ref.specifier)) {
        const resolved = resolveRelative(file, ref.specifier, fileSet);
        if (resolved === null) {
          gaps.push(
            v(adrId, startFile, file === startFile ? ref.line : 1, "forbid-import", ref.specifier, "gap",
              `${adrId}: cannot prove — unresolved import "${ref.specifier}" in ${file}`), // prettier-ignore
          );
        } else if (!seen.has(resolved)) {
          seen.add(resolved);
          queue.push({ file: resolved, chain: [...chain, resolved] });
        }
      }
    }
  }
  // No violation found; surface at most one gap per start file (deduped) so an unresolved
  // edge downgrades the result from clean-green to "unproven" without flooding output.
  return gaps.length ? [gaps[0]] : [];
}
