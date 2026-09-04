/**
 * kit — ADR → gate. Turn the machine-readable part of an Architecture Decision
 * Record into a deterministic gate, cited back to the ADR ("why is this blocked?
 * → ADR-0007").
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
import {
  evaluateTransitiveImport,
  extractImports,
  type AdrImportWalkContext,
  type ImportRef,
  type PackageResolver,
} from "./adr-import-graph.js";

export {
  extractImports,
  isBuiltinSpecifier,
  resolveRelative,
  type ImportRef,
  type PackageResolver,
} from "./adr-import-graph.js";

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
  /**
   * Repo-relative paths that enforce this ADR's claim OUTSIDE the `kit-enforce` block.
   *
   * Some decisions are not expressible in the block's grammar — measured cases: `paths`
   * has no negation, `forbid_pattern`/`require_pattern` match line by line so a JSON
   * block cannot be pinned, and the manifest is not in the walked file set at all. Before
   * this field the only options were to encode the rule wrong or to leave the ADR
   * declaring more than it enforced, silently. ADR-0002 sat in the second state for
   * months: titled "four runtime deps", enforcing "not these twelve imports".
   *
   * Naming the real enforcement point turns that silence into a claim, and a claim can be
   * checked — `adr check` fails when a path listed here does not exist, so the pointer
   * cannot rot into a lie.
   */
  enforcedBy: string[];
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

/**
 * A frontmatter list, in either shape:
 *
 *   enforced_by: [src/a.test.ts, src/b.test.ts]
 *   enforced_by:
 *     - src/a.test.ts
 *     - src/b.test.ts
 *
 * Deliberately tiny: this is not a YAML parser, it is two shapes an ADR author writes by
 * hand. Anything else yields an empty list rather than a guess.
 */
function list(frontmatter: string, key: string): string[] {
  const inline = frontmatter.match(new RegExp(`^${key}:[ \\t]*\\[(.*)\\][ \\t]*$`, "mi"));
  if (inline) {
    return inline[1]
      .split(",")
      .map((v) => v.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const blocked = frontmatter.match(
    new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]*-[^\\n]*\\n?)+)`, "mi"),
  );
  if (!blocked) return [];
  return blocked[1]
    .split("\n")
    .map((line) =>
      line
        .replace(/^[ \t]*-[ \t]*/, "")
        .trim()
        .replace(/^["']|["']$/g, ""),
    )
    .filter(Boolean);
}

function str(o: Record<string, unknown>, k: string): string | undefined {
  return typeof o[k] === "string" ? (o[k] as string) : undefined;
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

type AdrDocument = { frontmatter: string; body: string };

function parseAdrDocument(raw: string): AdrDocument | null {
  const text = raw.replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return match ? { frontmatter: match[1], body: match[2] } : null;
}

function parseAdrStatus(frontmatter: string): AdrStatus {
  const status = (scalar(frontmatter, "status") ?? "unknown").toLowerCase();
  return (STATUSES as string[]).includes(status) ? (status as AdrStatus) : "unknown";
}

function parsePatternRule(
  type: "forbid-pattern" | "require-pattern",
  rule: Record<string, unknown>,
): AdrRule | null {
  const pattern = str(rule, "pattern");
  const paths = str(rule, "paths");
  return pattern && paths ? { type, pattern, paths, message: str(rule, "message") } : null;
}

function parseForbidImportRule(rule: Record<string, unknown>): AdrRule | null {
  const imported = str(rule, "import");
  const paths = str(rule, "paths");
  if (!imported || !paths) return null;
  return {
    type: "forbid-import",
    import: imported,
    paths,
    transitive: rule.transitive === true,
    followPackages: rule.follow_packages === true,
    message: str(rule, "message"),
  };
}

function parseEnforceRules(source: string): AdrRule[] {
  try {
    const parsed = parseToml(source) as Record<string, unknown>;
    return [
      ...arr(parsed.forbid_pattern).map((rule) => parsePatternRule("forbid-pattern", rule)),
      ...arr(parsed.require_pattern).map((rule) => parsePatternRule("require-pattern", rule)),
      ...arr(parsed.forbid_import).map(parseForbidImportRule),
    ].filter((rule): rule is AdrRule => rule !== null);
  } catch {
    return [];
  }
}

function parseEnforcement(body: string): Pick<Adr, "rules" | "hasEnforceBlock"> {
  const block = body.match(/```toml\s+kit-enforce\s*\n([\s\S]*?)\n```/);
  return block
    ? { rules: parseEnforceRules(block[1]), hasEnforceBlock: true }
    : { rules: [], hasEnforceBlock: false };
}

/**
 * Parse an ADR markdown file. Returns null when it has no `---` frontmatter or no `id`
 * (not an ADR). Never throws — a malformed enforce block yields `hasEnforceBlock: true`
 * with zero rules (surfaced, not a crash).
 */
export function parseAdr(raw: string): Adr | null {
  const document = parseAdrDocument(raw);
  if (!document) return null;
  const id = scalar(document.frontmatter, "id");
  if (!id) return null;
  return {
    id,
    title: scalar(document.frontmatter, "title") ?? id,
    status: parseAdrStatus(document.frontmatter),
    ...parseEnforcement(document.body),
    enforcedBy: list(document.frontmatter, "enforced_by"),
  };
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

type AdrSourceFile = { path: string; content: string };

function createWalkContext(files: AdrSourceFile[], opts: EvaluateAdrOptions): AdrImportWalkContext {
  const fileSet = new Set(files.map((file) => file.path));
  const importCache = new Map<string, ImportRef[]>();
  const importsOf = (path: string, content: string): ImportRef[] => {
    let refs = importCache.get(path);
    if (!refs) {
      refs = extractImports(content);
      importCache.set(path, refs);
    }
    return refs;
  };
  return {
    fileSet,
    importsOf,
    contentByPath: new Map(files.map((file) => [file.path, file.content] as const)),
    packages: opts.packages,
    maxPackageDepth: opts.maxPackageDepth ?? DEFAULT_MAX_PACKAGE_DEPTH,
    maxNodes: opts.maxNodes ?? DEFAULT_MAX_NODES,
  };
}

function matchRuleFiles(paths: string, files: AdrSourceFile[]): AdrSourceFile[] {
  try {
    const matcher = globToRegExp(paths);
    return files.filter((file) => matcher.test(file.path));
  } catch {
    return [];
  }
}

type PatternRule = Exclude<AdrRule, { type: "forbid-import" }>;

function evaluatePatternRule(
  adrId: string,
  rule: PatternRule,
  file: AdrSourceFile,
  matcher: RegExp,
): AdrViolation[] {
  const line = firstMatchingLine(file.content, matcher);
  const forbidden = rule.type === "forbid-pattern";
  if (forbidden ? line < 0 : line >= 0) return [];
  return [
    {
      adrId,
      file: file.path,
      line: forbidden ? line + 1 : 1,
      rule: rule.type,
      detail: rule.pattern,
      kind: "violation",
      message:
        rule.message ??
        (forbidden
          ? `forbidden by ${adrId}: /${rule.pattern}/`
          : `${adrId} requires /${rule.pattern}/ — missing in this file`),
    },
  ];
}

function evaluateDirectImport(
  adrId: string,
  rule: Extract<AdrRule, { type: "forbid-import" }>,
  file: AdrSourceFile,
  matcher: RegExp,
  ctx: AdrImportWalkContext,
): AdrViolation[] {
  return ctx
    .importsOf(file.path, file.content)
    .filter((ref) => matcher.test(ref.specifier))
    .map(
      (ref): AdrViolation => ({
        adrId,
        file: file.path,
        line: ref.line,
        rule: "forbid-import",
        detail: ref.specifier,
        kind: "violation",
        message: rule.message ?? `${adrId} forbids importing "${ref.specifier}"`,
      }),
    );
}

function evaluateForbidImport(
  adrId: string,
  rule: Extract<AdrRule, { type: "forbid-import" }>,
  files: AdrSourceFile[],
  matcher: RegExp,
  ctx: AdrImportWalkContext,
): AdrViolation[] {
  const violations: AdrViolation[] = [];
  for (const file of files) {
    const found = rule.transitive
      ? evaluateTransitiveImport(adrId, rule, file.path, matcher, ctx)
      : evaluateDirectImport(adrId, rule, file, matcher, ctx);
    violations.push(...found);
  }
  return violations;
}

function evaluateRule(
  adrId: string,
  rule: AdrRule,
  files: AdrSourceFile[],
  ctx: AdrImportWalkContext,
): AdrViolation[] {
  const matched = matchRuleFiles(rule.paths, files);
  const source = rule.type === "forbid-import" ? rule.import : rule.pattern;
  const matcher = safeRegExp(source);
  if (!matcher) return [];
  return rule.type === "forbid-import"
    ? evaluateForbidImport(adrId, rule, matched, matcher, ctx)
    : matched.flatMap((file) => evaluatePatternRule(adrId, rule, file, matcher));
}

/**
 * Evaluate an accepted ADR's rules over the provided files. Pure — the caller supplies
 * `{ path, content }` for the repo; this never touches disk. A non-accepted ADR (or one
 * with no rules) yields no violations. Line numbers are 1-indexed.
 */
export function evaluateAdr(
  adr: Adr,
  files: AdrSourceFile[],
  opts: EvaluateAdrOptions = {},
): AdrViolation[] {
  if (adr.status !== "accepted") return [];
  const walkCtx = createWalkContext(files, opts);
  return adr.rules.flatMap((rule) => evaluateRule(adr.id, rule, files, walkCtx));
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
