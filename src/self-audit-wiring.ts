// Class 15 analyzer for `kit self-audit`: wiring integrity — code that was built,
// tested, and never connected to anything.
//
// This exists because of one finding. kit's README described classified memory as a
// working disclosure control: "a note captured in a restricted repo cannot surface
// while you work in a public one." The class column existed. The fail-closed
// resolution existed and was unit-tested. The recall filter existed. And
// `resolveMemoryClass()` had ZERO production callers, `[memory] default_class` was
// read in zero places, and 0 of 30 `openMemoryDb()` call sites passed a class.
// Nothing connected any of it. Every row took the built-in default.
//
// A passing unit test is not evidence that a feature is reachable. That is the whole
// point of this rule: the test suite and the docs can BOTH be green while the wire is
// missing, because each was checking the piece rather than the path. So the oracle
// here is deliberately not the tests — it is production call sites.
//
// Two tiers, because they mean different things:
//
//   tested-never-called  — built + tested + unreachable. The dangerous shape: it
//                          looks finished from every angle a reviewer checks.
//   referenced-nowhere   — plain dead code. Cheaper to judge, safe to delete.
//
// Advisory severity, one row per finding. Same reasoning as flag-validation: the
// honest state is that kit has ~70 of these, `--fail-on-warning` must stay green on
// kit's own tree (cli.test.ts pins that), and a count that can only go down is worth
// more than a gate switched off. Deleting a dead export is safe; UNWIRING a control is
// what this catches, and that judgement belongs to a human.
//
// Pure + deterministic: no network, no LLM, no AST (kit ships no parser — regex and
// line scans, same as every other self-audit rule).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

const WIRING_CATEGORY: SecurityCheckResult["category"] = "self-audit/unwired-code";

/** Subtrees the walk never enters. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next", "tmp"]);

/** Where the adapter-SDK public export list lives — those are called by plugins. */
const SURFACE_PATH = "contracts/public-surface.json";

export interface ExportedFn {
  /** Function name as declared. */
  name: string;
  /** Repo-relative posix path of the declaring file. */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
}

export interface WiringFinding extends ExportedFn {
  /** True when a test references it — built, tested, and still unreachable. */
  testedOnly: boolean;
}

/**
 * Names that are unreachable from production ON PURPOSE, so flagging them would be
 * noise:
 *
 * - `_`-prefixed and `…ForTests` — reset/seam helpers a test drives directly. kit
 *   already names them so a reader can tell; the rule honours that convention.
 * - anything listed in the adapter-SDK public surface — plugin authors call those
 *   from outside the repo, so there is no in-repo call site by design.
 */
export function isIntentionallyUncalled(name: string, sdkExports: ReadonlySet<string>): boolean {
  if (name.startsWith("_")) return true;
  if (name.endsWith("ForTests")) return true;
  return sdkExports.has(name);
}

/** Read the adapter-SDK export list. Missing/unparsable ⇒ empty (nothing excluded). */
export function loadSdkExports(repoRoot: string): Set<string> {
  try {
    const raw = readFileSync(join(repoRoot, SURFACE_PATH), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { adapterSdk?: { exports?: unknown } })?.adapterSdk?.exports;
    return Array.isArray(list)
      ? new Set(list.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Exported top-level function declarations in a module, with 1-based lines.
 * `export function` / `export async function` only — kit declares its module API
 * that way, and arrow consts are deliberately out of scope rather than matched
 * loosely (a loose match here would produce the false positives that make a gate
 * worthless).
 */
export function collectExportedFunctions(text: string, file: string): ExportedFn[] {
  const out: ExportedFn[] = [];
  text.split("\n").forEach((line, i) => {
    const m = line.match(/^export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) out.push({ name: m[1], file, line: i + 1 });
  });
  return out;
}

interface SourceSet {
  production: { file: string; text: string }[];
  testText: string;
}

/** Read every `.ts` under `src`, split into production and test text. */
export function readSources(repoRoot: string): SourceSet {
  const production: { file: string; text: string }[] = [];
  const testChunks: string[] = [];
  function visit(dir: string, rel: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        visit(join(dir, e.name), childRel);
        continue;
      }
      if (!e.name.endsWith(".ts")) continue;
      let text;
      try {
        text = readFileSync(join(dir, e.name), "utf-8");
      } catch {
        continue;
      }
      if (e.name.endsWith(".test.ts")) testChunks.push(text);
      else production.push({ file: `src/${childRel}`, text });
    }
  }
  visit(join(repoRoot, "src"), "");
  return { production, testText: testChunks.join("\n") };
}

/**
 * Find exported production functions with no production call site.
 *
 * Reference counting is whole-word over production text, minus one for the
 * declaration itself — so a helper used only inside its own module counts as wired
 * (that is normal, good code), and only a name that appears exactly once anywhere in
 * production is reported.
 */
export function analyzeWiring(repoRoot: string): WiringFinding[] {
  const { production, testText } = readSources(repoRoot);
  const sdkExports = loadSdkExports(repoRoot);
  const findings: WiringFinding[] = [];

  for (const { file, text } of production) {
    for (const fn of collectExportedFunctions(text, file)) {
      if (isIntentionallyUncalled(fn.name, sdkExports)) continue;
      const re = new RegExp(`\\b${fn.name}\\b`, "g");
      let uses = 0;
      for (const other of production) uses += (other.text.match(re) ?? []).length;
      if (uses - 1 > 0) continue; // called somewhere in production
      findings.push({ ...fn, testedOnly: new RegExp(`\\b${fn.name}\\b`).test(testText) });
    }
  }
  return findings;
}

/**
 * Advisory rows, one per unwired export. A count per category is what the self-audit
 * advisory renderer prints, so row-per-finding makes the count the metric.
 */
export function runWiringAudit(repoRoot: string): SecurityCheckResult[] {
  const findings = analyzeWiring(repoRoot);
  if (findings.length === 0) {
    return [
      {
        category: WIRING_CATEGORY,
        name: "wiring",
        status: "pass",
        detail: "every exported production function has a production call site",
      },
    ];
  }
  return findings.map((f) => ({
    category: WIRING_CATEGORY,
    name: "wiring",
    status: "warn" as const,
    severity: "low" as const,
    detail: f.testedOnly
      ? `${f.name} is exported and TESTED but has no production call site — a passing test is not proof a feature is reachable`
      : `${f.name} is exported and referenced nowhere in production`,
    files: [`${f.file}:${f.line}`],
    suggestion: `wire it, or delete it — the classified-memory control was built, tested and unreachable for exactly this reason`,
  }));
}
