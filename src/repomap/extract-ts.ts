/**
 * Repo-map — TS/JS import extractor (deterministic, dependency-free, zero-LLM).
 *
 * Parses import specifiers from TS/JS/JSX source and resolves the relative ones to repo-relative file
 * ids against a known file set. Non-relative specifiers (npm packages, node: builtins) are reported as
 * external — kept as graph nodes, never traversed. No compiler, no model: a small, explainable set of
 * import forms, matched by regex so the result is reproducible from source alone.
 */

/**
 * Extract raw import specifiers from source: `import ... from "x"`, side-effect `import "x"`,
 * `export ... from "x"`, `require("x")`, and dynamic `import("x")`. Line comments starting with `//`
 * are stripped first to avoid false hits; block comments are left (rare to hold import-shaped text).
 * Deterministic; order-preserving; deduped. Pure.
 */
export function parseImportSpecifiers(source: string): string[] {
  const noLineComments = source.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const specs: string[] = [];
  const push = (s: string | undefined) => {
    if (s && !specs.includes(s)) specs.push(s);
  };
  const q = `['"]([^'"\\n]+)['"]`;
  const patterns = [
    new RegExp(`\\bimport\\b[^;'"\\n]*\\bfrom\\s*${q}`, "g"), // import x from "…"
    new RegExp(`\\bimport\\s*${q}`, "g"), // side-effect import "…"
    new RegExp(`\\bexport\\b[^;'"\\n]*\\bfrom\\s*${q}`, "g"), // export … from "…"
    new RegExp(`\\brequire\\s*\\(\\s*${q}\\s*\\)`, "g"), // require("…")
    new RegExp(`\\bimport\\s*\\(\\s*${q}\\s*\\)`, "g"), // dynamic import("…")
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(noLineComments)) !== null) push(m[1]);
  }
  return specs;
}

/** True for a relative specifier (`.`/`..`) — the only kind we resolve in-repo. */
export function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
}

const CANDIDATE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Resolve a relative `spec` imported from repo-relative `fromRel` to a member of `fileSet`
 * (repo-relative posix paths), or null if it doesn't resolve to a known file (external, or missing).
 * Handles TS/ESM `.js`→`.ts` rewrite and directory `index.*`. Pure — takes the file set, does no I/O.
 */
export function resolveImport(fromRel: string, spec: string, fileSet: Set<string>): string | null {
  if (!isRelativeSpecifier(spec)) return null; // external (npm/builtin) — caller marks it external

  const fromDir = posixDir(fromRel);
  const base = normalizePosix(joinPosix(fromDir, spec));

  const candidates: string[] = [];
  // exact (already has a known extension)
  if (CANDIDATE_EXTS.some((e) => base.endsWith(e))) candidates.push(base);
  // TS/ESM: an import written as "./x.js" often maps to "./x.ts" (or .tsx)
  const jsLike = base.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsLike) for (const e of [".ts", ".tsx"]) candidates.push(base.replace(/\.\w+$/, e));
  // extensionless: try file + each ext, then index files
  if (!/\.\w+$/.test(base)) {
    for (const e of CANDIDATE_EXTS) candidates.push(base + e);
    for (const e of CANDIDATE_EXTS) candidates.push(joinPosix(base, "index" + e));
  }
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

// ── tiny posix path helpers (deterministic; avoid node:path platform differences) ──
function posixDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function joinPosix(a: string, b: string): string {
  if (!a) return b;
  return `${a}/${b}`;
}
function normalizePosix(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
