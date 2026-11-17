// Class 16 analyzer for `kit self-audit`: unreferenced exports.
//
// A manual pass found five exports nothing in the repository referenced (#864):
// a "legacy" handler, a redaction helper, a tool list whose comment described a list
// `kit standards` does not read, and two test-only reset helpers no test used. R15
// (wiring) missed all five: it reads `export function` only, and it reports
// advisories nobody has to act on. This rule is the strict one: an exported
// `function`, `const`, `let` or `class` in non-test `src/**/*.ts` whose name appears
// in no OTHER file of `src/`, `scripts/`, `packages/`, `skills/` or `bin/` fails.
// Tests count as references — a test-only seam is used by its test.
//
// Speed is part of correctness here. A regex per name over every file took over two
// minutes, which is what pushes a gate out of CI. So the repository is read once into
// a word index (word → the files it occurs in), and each export is one map lookup.
//
// What a word index cannot see, and how each case is handled:
//
//   `export { a as b }`      — the exported name is `b`; `b` is what other files must
//                              mention. A local `export { a }` list is read the same way.
//   `export { x } from "…"`  — a re-export is not a use. Its words are left out of the
//                              index, so `x` re-exported by a barrel nobody imports from
//                              is still reported at its declaration; a consumer that
//                              imports `x` from the barrel mentions `x` and keeps it.
//   `export { x as y } from` — consumers name `y`, never `x`, so `x` is referenced when
//                              `y` is (followed through chains of renames).
//   `export * from "…"`      — names nothing, so it adds nothing to the index.
//   package entry modules    — `package.json` `main`/`exports` targets are the npm
//                              surface; callers live outside the repository by design.
//   adapter-SDK surface      — `contracts/public-surface.json` names what plugins call.
//   protected paths          — a finding under `.github/kit-protected-paths.json` is an
//                              advisory in its own category: deleting code there needs
//                              the owner, so the rule counts it and never gates on it.
//
// A word that occurs anywhere else counts, comments and strings included. That makes
// the rule miss a dead export whose name is a common word; it never makes it report a
// live one. A gate that cries wolf is worse than none, so the error runs that way.

import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { loadSdkExports } from "./self-audit-wiring.js";
import {
  classifyProtectedPaths,
  loadProtectedPathRules,
  type ProtectedPathRules,
} from "./review-protected-paths.js";

const CATEGORY: SecurityCheckResult["category"] = "self-audit/unreferenced-export";
const PROTECTED_CATEGORY: SecurityCheckResult["category"] =
  "self-audit/unreferenced-export-protected";

/** Top-level trees whose files count as references. */
const REFERENCE_ROOTS = ["src", "scripts", "packages", "skills", "bin"];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next", "tmp"]);
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|tgz|wasm|woff2?|ttf|node|db|sqlite)$/i;

export interface RepoFile {
  /** Repo-relative posix path. */
  path: string;
  text: string;
}

export interface ExportDecl {
  name: string;
  file: string;
  line: number;
}

/** Read every text file under the reference roots. */
function readReferenceFiles(repoRoot: string): RepoFile[] {
  const out: RepoFile[] = [];
  const visit = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // a missing root (no `bin/`) is normal
    }
    for (const e of entries) {
      const childRel = posix.join(rel, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) visit(join(abs, e.name), childRel);
      } else if (e.isFile() && !BINARY_EXT.test(e.name)) {
        out.push({ path: childRel, text: readFileSync(join(abs, e.name), "utf-8") });
      }
    }
  };
  for (const root of REFERENCE_ROOTS) visit(join(repoRoot, root), root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// `export { … } from "…"` and `export * from "…"`, multi-line included.
const RE_EXPORT_RE =
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"']*["']/g;

/** Blank out re-export statements, keeping newlines so line numbers survive. */
export function stripReExports(text: string): string {
  return text.replace(RE_EXPORT_RE, (m) => m.replace(/[^\n]/g, " "));
}

const WORD_RE = /[A-Za-z_$][\w$]*/g;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** `a` → the names `export { a as b } from` re-exports it under, across all files. */
export function collectReExportAliases(files: RepoFile[]): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const f of files) {
    for (const m of f.text.matchAll(RE_EXPORT_RE)) {
      const list = /\{([^}]*)\}/.exec(m[0]);
      for (const spec of list ? list[1].split(",") : []) {
        const [from, to] = spec
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/);
        if (!to || !IDENT_RE.test(from) || !IDENT_RE.test(to.trim())) continue;
        aliases.set(from, [...(aliases.get(from) ?? []), to.trim()]);
      }
    }
  }
  return aliases;
}

/** word → index of the first file it occurs in, or -1 once it occurs in two. */
export type WordIndex = Map<string, number>;

export function buildWordIndex(files: RepoFile[]): WordIndex {
  const index: WordIndex = new Map();
  files.forEach((f, i) => {
    for (const word of new Set(stripReExports(f.text).match(WORD_RE) ?? [])) {
      const seen = index.get(word);
      if (seen === undefined) index.set(word, i);
      else if (seen !== i) index.set(word, -1);
    }
  });
  return index;
}

const DECL_RE =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/;
// A local export list: `export { a, b as c };` (no `from`).
const LIST_RE = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g;

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Exported value declarations in one module, by their exported names. */
export function collectExports(text: string, file: string): ExportDecl[] {
  const out: ExportDecl[] = [];
  text.split("\n").forEach((l, i) => {
    const m = DECL_RE.exec(l);
    if (m) out.push({ name: m[1], file, line: i + 1 });
  });
  const body = stripReExports(text);
  for (const m of body.matchAll(LIST_RE)) {
    const line = lineAt(body, m.index ?? 0);
    for (const spec of m[1].split(",")) {
      const parts = spec
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0]).trim();
      if (IDENT_RE.test(name) && name !== "default") out.push({ name, file, line });
    }
  }
  return out;
}

/** Repo-relative `src/…ts` paths of the package entry modules (`main` / `exports`). */
export function entryModules(repoRoot: string): Set<string> {
  const out = new Set<string>();
  let pkg: { main?: unknown; exports?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as typeof pkg;
  } catch {
    return out;
  }
  const targets: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") targets.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(pkg.main);
  collect(pkg.exports);
  for (const t of targets) {
    const m = /^(?:\.\/)?dist\/(.+)\.js$/.exec(t);
    if (m) out.add(`src/${m[1]}.ts`);
  }
  return out;
}

export interface ExportFinding extends ExportDecl {
  protectedPath: boolean;
}

function isProductionSource(path: string): boolean {
  return (
    path.startsWith("src/") &&
    path.endsWith(".ts") &&
    !path.endsWith(".d.ts") &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".test-support.ts")
  );
}

/** Is `name` (declared in file `self`) named by any other file, directly or via a rename? */
export function isReferenced(
  name: string,
  self: number,
  index: WordIndex,
  aliases: Map<string, string[]>,
  seen: Set<string> = new Set(),
): boolean {
  const where = index.get(name);
  if (where === -1 || (where !== undefined && where !== self)) return true;
  seen.add(name);
  return (aliases.get(name) ?? []).some(
    (to) => !seen.has(to) && isReferenced(to, self, index, aliases, seen),
  );
}

function protectedRules(repoRoot: string): ProtectedPathRules | null {
  try {
    return loadProtectedPathRules(repoRoot);
  } catch {
    return null;
  }
}

/** Every export whose name occurs in no other reference file. */
export function analyzeExports(repoRoot: string): ExportFinding[] {
  const files = readReferenceFiles(repoRoot);
  const index = buildWordIndex(files);
  const aliases = collectReExportAliases(files);
  const sdk = loadSdkExports(repoRoot);
  const entries = entryModules(repoRoot);
  const rules = protectedRules(repoRoot);
  const findings: ExportFinding[] = [];
  files.forEach((f, i) => {
    if (!isProductionSource(f.path) || entries.has(f.path)) return;
    for (const decl of collectExports(f.text, f.path)) {
      if (sdk.has(decl.name)) continue;
      if (isReferenced(decl.name, i, index, aliases)) continue;
      // Unreadable rules: treat as protected, so the rule reports and never gates on a guess.
      const isProtected = rules ? classifyProtectedPaths([f.path], rules).length > 0 : true;
      findings.push({ ...decl, protectedPath: isProtected });
    }
  });
  return findings;
}

export function runExportsAudit(repoRoot: string): SecurityCheckResult[] {
  const findings = analyzeExports(repoRoot);
  if (findings.length === 0) {
    return [
      {
        category: CATEGORY,
        name: "unreferenced exports",
        status: "pass",
        detail: `every exported function, const, let and class in src is referenced from another file of ${REFERENCE_ROOTS.join(", ")}`,
      },
    ];
  }
  return findings.map((f) => ({
    category: f.protectedPath ? PROTECTED_CATEGORY : CATEGORY,
    name: "unreferenced exports",
    status: f.protectedPath ? ("warn" as const) : ("fail" as const),
    severity: f.protectedPath ? ("low" as const) : ("high" as const),
    detail: `${f.name} is exported and no other file names it${f.protectedPath ? " (protected path: the owner decides)" : ""}`,
    files: [`${f.file}:${f.line}`],
    suggestion: "delete it, or drop `export` if the module uses it itself",
  }));
}
