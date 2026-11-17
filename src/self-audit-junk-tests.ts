// Class 18 analyzer for `kit self-audit`: tests that test nothing.
//
// OpenClaw's test-audit skill keeps a junk-pattern list that its authoring gate rejects. Most of
// it is judgement, but part of it can be decided from text with no model (kit-research,
// openclaw-test-audit-skill-vs-kit §4). This rule checks the patterns from that list that a
// line-and-brace reading of a test file can decide:
//
//   assertion-free   — an `it(…)`/`test(…)` whose body asserts nothing: no `assert`, no
//                      `expect`, no `throw`, and no call to a helper in the file (or in an
//                      imported `.test-support` module) that asserts. Such a test passes
//                      whenever the code under it does not throw.
//   self-comparison  — an assertion whose actual and expected are the same text
//                      (`assert.equal(x, x)`, `expect(x).toBe(x)`), or a constant truth
//                      (`assert.ok(true)`, `assert(true)`, `expect(true).toBe(true)`).
//   duplicate        — two tests in one file whose bodies are the same text, which invoke
//                      the same contract twice under two names.
//
// Left out on purpose: "exact source, import, or string greps". kit has tests that read
// source text on purpose (`src/file-identity-discipline.test.ts`), and the same note's
// retention bar says such a test may be the cheapest independent guard. Text cannot tell the
// two apart, and a gate that flags the guards would be worse than none. "Expected values
// produced by the helper under test" needs a call graph, so it is out too.
//
// The reading is deliberately conservative: a body whose braces do not balance (a regex
// literal with a brace, say) is skipped, never reported. Every miss runs toward silence.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

const CATEGORY: SecurityCheckResult["category"] = "self-audit/junk-tests";

/** Words that make a body count as asserting. `throw` covers hand-rolled checks. */
const ASSERTS = /\b(?:assert|expect|throw|should)\b|\.(?:plan|fail)\(/;

/** `it("…"` / `test('…'` / `it.only(`…` at a line start, with the title opening. */
const TEST_START = /^\s*(?:it|test)(?:\.only)?\(\s*["'`]/;

export interface JunkFinding {
  line: number;
  kind: "assertion-free" | "self-comparison" | "duplicate";
  detail: string;
}

/**
 * Index just past the bracket that closes the one at `open` (`{` or `(`), or -1 if it never
 * balances. Strings, template literals and comments are skipped.
 */
function closeBrace(text: string, open: number): number {
  const opener = text[open];
  const closer = opener === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    const skipped = skipNonCode(text, i);
    if (skipped === -1) return -1;
    if (skipped !== i) i = skipped;
    else if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * When a comment or string starts at `i`, the index of its last character (-1 if it never
 * ends); otherwise `i` itself.
 */
function skipNonCode(text: string, i: number): number {
  const ch = text[i];
  if (ch === "/" && text[i + 1] === "/") return text.indexOf("\n", i);
  if (ch === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? -1 : end + 1;
  }
  if (ch === '"' || ch === "'" || ch === "`") return skipString(text, i);
  return i;
}

/** Index of the closing quote of the string opened at `start`. Template `${…}` is entered. */
function skipString(text: string, start: number): number {
  const q = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === q) return i;
    else if (q !== "`" && ch === "\n") return -1;
    else if (q === "`" && ch === "$" && text[i + 1] === "{") {
      const end = closeBrace(text, i + 1);
      if (end === -1) return -1;
      i = end - 1;
    }
  }
  return -1;
}

interface TestBlock {
  line: number;
  title: string;
  /** The whole `it(…)` call after its title: options, callback and fixture arguments. */
  body: string;
}

/** The test blocks of a file: each `it`/`test` call whose parentheses balance. */
export function testBlocks(text: string): TestBlock[] {
  const out: TestBlock[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (let n = 0; n < lines.length; n++) {
    const start = offset;
    offset += lines[n].length + 1;
    if (!TEST_START.test(lines[n])) continue;
    const open = text.indexOf("(", start);
    const close = closeBrace(text, open);
    if (close === -1) continue;
    const titleStart = text.slice(open + 1).search(/\S/) + open + 1;
    const titleEnd = skipString(text, titleStart);
    if (titleEnd === -1) continue;
    out.push({
      line: n + 1,
      title: text.slice(titleStart + 1, titleEnd),
      body: text.slice(titleEnd + 1, close - 1),
    });
  }
  return out;
}

/** Names of functions declared in `text` whose own body asserts (one level; helpers of helpers too). */
function assertingHelpers(text: string): Set<string> {
  const decls: { name: string; body: string }[] = [];
  const re =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1] ?? m[2];
    const open = text.indexOf("{", m.index + m[0].length - 1);
    const nl = text.indexOf("\n", m.index + m[0].length);
    // An expression-bodied arrow: its body is the rest of the statement's first line.
    if (open === -1 || (m[2] && nl !== -1 && open > nl)) {
      decls.push({ name, body: text.slice(m.index, nl === -1 ? undefined : nl) });
      continue;
    }
    const close = closeBrace(text, open);
    if (close !== -1) decls.push({ name, body: text.slice(open, close) });
  }
  const found = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const d of decls) {
      if (found.has(d.name)) continue;
      if (ASSERTS.test(d.body) || callsAny(d.body, found)) {
        found.add(d.name);
        grew = true;
      }
    }
  }
  return found;
}

function callsAny(body: string, names: Set<string>): boolean {
  for (const name of names) if (new RegExp(`\\b${escapeRe(name)}\\s*[(<]`).test(body)) return true;
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Names imported from a module whose text asserts (a `.test-support` file, read by the caller). */
function importedAsserting(text: string, readImport: (spec: string) => string): Set<string> {
  const out = new Set<string>();
  const re = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[2].startsWith(".")) continue;
    if (!ASSERTS.test(readImport(m[2]))) continue;
    for (const part of m[1].split(",")) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.replace(/^type\s+/, "");
      if (local) out.add(local);
    }
  }
  return out;
}

/** Compact text for comparing two expressions: no whitespace. */
const squash = (s: string): string => s.replace(/\s+/g, "");

/** Split `a, b` at the top-level comma; null when there are not exactly two parts. */
function twoArgs(args: string): [string, string] | null {
  let depth = 0;
  const cuts: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(args, i);
      if (end === -1) return null;
      i = end;
    } else if (ch === "," && depth === 0) cuts.push(i);
  }
  const parts = cuts.length === 0 ? [] : [args.slice(0, cuts[0]), args.slice(cuts[0] + 1, cuts[1])];
  return parts.length === 2 && parts[1].trim() !== "" ? [parts[0], parts[1]] : null;
}

const COMPARE =
  /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(([^;\n]*)\)\s*;?\s*$|expect\(([^;\n]*?)\)\.(?:toBe|toEqual|toStrictEqual)\(([^;\n]*)\)\s*;?\s*$/;
const CONSTANT_TRUE =
  /\bassert(?:\.ok)?\(\s*true\s*[,)]|expect\(\s*true\s*\)\.(?:toBe|toEqual)\(\s*true\s*\)/;

/** A line that asserts a value against itself, or asserts the constant `true`. */
export function selfComparison(line: string): string | null {
  if (CONSTANT_TRUE.test(line)) return "asserts the constant `true`";
  const m = COMPARE.exec(line);
  if (!m) return null;
  const pair: [string, string] | null = m[1] !== undefined ? twoArgs(m[1]) : [m[2], m[3]];
  if (!pair) return null;
  const [a, b] = pair.map(squash);
  // `f(x), f(x)` calls twice and is a determinism check, not a tautology: only a value
  // with no call in it (a name, a property path, a literal) compared with itself is junk.
  return a !== "" && a === b && !a.includes("(") ? "compares a value with itself" : null;
}

/** Every junk pattern in one test file. `readImport` returns an imported module's text, or "". */
export function findJunkTests(text: string, readImport: (spec: string) => string): JunkFinding[] {
  const helpers = assertingHelpers(text);
  for (const name of importedAsserting(text, readImport)) helpers.add(name);
  const findings: JunkFinding[] = [];
  const seen = new Map<string, TestBlock>();
  for (const block of testBlocks(text)) {
    const body = block.body;
    if (!ASSERTS.test(body) && !callsAny(body, helpers)) {
      findings.push({
        line: block.line,
        kind: "assertion-free",
        detail: `test "${block.title}" asserts nothing: it passes whenever the code does not throw`,
      });
    }
    // A test written in a loop has a template title, and its body differs by the loop's data.
    if (block.title.includes("${")) continue;
    const key = squash(body);
    const first = seen.get(key);
    if (first) {
      findings.push({
        line: block.line,
        kind: "duplicate",
        detail: `test "${block.title}" has the same body as "${first.title}" (line ${first.line})`,
      });
    } else seen.set(key, block);
  }
  text.split("\n").forEach((l, i) => {
    const why = selfComparison(l);
    if (why) findings.push({ line: i + 1, kind: "self-comparison", detail: `${why}: ${l.trim()}` });
  });
  return findings.sort((a, b) => a.line - b.line);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "tmp"]);

function testFiles(root: string, rel = ""): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const child = rel ? posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...testFiles(root, child));
    else if (/\.test\.ts$/.test(e.name)) out.push(child);
  }
  return out;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The importer's view of `./x.js`: the `.ts` source next to it. */
function importSource(abs: string, spec: string): string {
  return readOrEmpty(join(dirname(abs), spec.replace(/\.js$/, ".ts")));
}

/** R18: every junk pattern in `src/**\/*.test.ts`, one result per finding. */
export function runJunkTestsAudit(repoRoot: string, name: string): SecurityCheckResult[] {
  const results: SecurityCheckResult[] = [];
  for (const rel of testFiles(join(repoRoot, "src"))) {
    const abs = join(repoRoot, "src", rel);
    for (const f of findJunkTests(readOrEmpty(abs), (spec) => importSource(abs, spec))) {
      results.push({
        category: CATEGORY,
        name,
        status: "fail",
        severity: "medium",
        detail: `${f.kind}: ${f.detail}`,
        files: [`src/${rel}:${f.line}`],
      });
    }
  }
  if (results.length > 0) return results;
  return [{ category: CATEGORY, name, status: "pass", detail: "no junk-pattern tests in src" }];
}
