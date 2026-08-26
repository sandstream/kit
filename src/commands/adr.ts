/**
 * `kit adr` — ADR → gate. Enforce the machine-readable `kit-enforce` block of an
 * accepted Architecture Decision Record, cited back to the ADR.
 *
 *   kit adr list    every ADR + status + enforced / documented-only
 *   kit adr check   run accepted ADRs' rules over the repo (default): forbid_pattern,
 *                   require_pattern, and forbid_import (direct, transitive, cross-package)
 *   kit adr freeze  snapshot current violations/gaps into .kit-baseline.json so only
 *                   NEW ones gate (mirrors `kit standards freeze`)
 *
 * kit never interprets ADR prose (off-charter); it enforces only the explicit
 * toml block. Only `accepted` ADRs gate; an accepted ADR with no rules is surfaced
 * as "documented, not enforced" — never silently green. A transitive forbid_import
 * that hits an unresolvable relative import is a `gap` (can't prove), not a pass.
 *
 * This file also owns the impure `node_modules` resolver injected into the pure evaluator
 * so `follow_packages = true` can cross npm package boundaries without src/adr.ts doing I/O.
 *
 * `adrCheck` is the embeddable gate reused by `kit review` and the pre-commit hook.
 */
import { readFileSync as read, existsSync as exists, statSync } from "node:fs";
import { relative as rel, join as pathJoin, dirname, isAbsolute } from "node:path";
import { c } from "../utils/colors.js";
import { walkSourceFiles } from "../source-walk.js";
import {
  parseAdr,
  evaluateAdr,
  adrIsEnforced,
  type Adr,
  type AdrViolation,
  type PackageResolver,
} from "../adr.js";
import { baselineSet, type Baseline } from "../baseline.js";

const ADR_DIRS = ["docs/adr", "docs/decisions"];
const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php"];
const BASELINE_CATEGORY = "adr";
/** Extensions tried when a specifier omits one (`.json` included: a JSON module is a real edge). */
const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `<path>`, `<path><ext>`, then `<path>/index<ext>` — Node/TS resolution, narrowed to files. */
function tryFile(base: string): string | null {
  const bases = [base];
  const jsExt = base.match(/\.(js|jsx|mjs|cjs)$/);
  // A `.js` specifier compiled from TS resolves to the `.ts` source (ESM/TS convention).
  if (jsExt) bases.push(base.slice(0, -jsExt[0].length));
  for (const b of bases) {
    for (const ext of RESOLVE_EXTS) if (isFile(b + ext)) return b + ext;
    for (const ext of RESOLVE_EXTS.slice(1)) {
      const idx = pathJoin(b, `index${ext}`);
      if (isFile(idx)) return idx;
    }
  }
  return null;
}

/** Split a bare specifier into package name + subpath. Null for `#imports` (private mappings). */
function splitBare(specifier: string): { name: string; sub: string } | null {
  if (specifier.startsWith("#")) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return null;
    return { name: parts.slice(0, 2).join("/"), sub: parts.slice(2).join("/") };
  }
  return { name: parts[0], sub: parts.slice(1).join("/") };
}

/** Entry-point candidates from a package.json, most specific first. */
function entryCandidates(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
  };
  const exp = pkg.exports;
  if (typeof exp === "string") push(exp);
  else if (exp && typeof exp === "object") {
    const root = (exp as Record<string, unknown>)["."] ?? exp;
    if (typeof root === "string") push(root);
    else if (root && typeof root === "object") {
      for (const cond of ["import", "module", "require", "node", "default"]) {
        const v = (root as Record<string, unknown>)[cond];
        push(v);
        if (v && typeof v === "object") push((v as Record<string, unknown>).default);
      }
    }
  }
  push(pkg.module);
  push(pkg.main);
  return out;
}

/** Nearest `node_modules/<name>` walking up from `fromDir`, as Node itself resolves. */
function findPackageDir(fromDir: string, name: string): string | null {
  let dir = fromDir;
  for (;;) {
    const cand = pathJoin(dir, "node_modules", name);
    try {
      if (statSync(cand).isDirectory()) return cand;
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A package's declared entry point (exports → module → main → index), or null. */
function resolvePackageEntry(pkgDir: string): string | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(read(pathJoin(pkgDir, "package.json"), "utf-8"));
  } catch {
    return tryFile(pathJoin(pkgDir, "index")); // no/unreadable manifest → CJS default only
  }
  for (const cand of entryCandidates(manifest)) {
    const hit = tryFile(pathJoin(pkgDir, cand));
    if (hit) return hit;
  }
  return tryFile(pathJoin(pkgDir, "index"));
}

/** Resolve a bare specifier as imported from `fromDir`, via the nearest `node_modules`. */
function resolveBare(fromDir: string, specifier: string): string | null {
  const bare = splitBare(specifier);
  if (!bare) return null;
  const pkgDir = findPackageDir(fromDir, bare.name);
  if (!pkgDir) return null;
  return bare.sub ? tryFile(pathJoin(pkgDir, bare.sub)) : resolvePackageEntry(pkgDir);
}

/**
 * The impure half of the ADR gate: the fs-backed resolver that lets a transitive
 * `forbid_import` with `follow_packages = true` cross npm package boundaries. Deliberately
 * conservative — anything it cannot resolve or read returns null, which `evaluateAdr` turns
 * into a `gap` (unproven), never a pass. Keys are absolute paths; results are memoized so a
 * fan-in module is stat'ed once per run.
 */
export function createNodeModulesResolver(cwd: string): PackageResolver {
  const resolveCache = new Map<string, string | null>();
  const readCache = new Map<string, string | null>();
  return {
    resolve(fromFile, specifier) {
      const from = isAbsolute(fromFile) ? fromFile : pathJoin(cwd, fromFile);
      const key = `${from}\u0000${specifier}`;
      const hit = resolveCache.get(key);
      if (hit !== undefined) return hit;
      const out = specifier.startsWith(".")
        ? tryFile(pathJoin(dirname(from), specifier))
        : resolveBare(dirname(from), specifier);
      resolveCache.set(key, out);
      return out;
    },
    read(key) {
      const hit = readCache.get(key);
      if (hit !== undefined) return hit;
      let out: string | null;
      try {
        out = read(key, "utf-8");
      } catch {
        out = null;
      }
      readCache.set(key, out);
      return out;
    },
  };
}

function loadAdrs(cwd: string): { adr: Adr; file: string }[] {
  const out: { adr: Adr; file: string }[] = [];
  for (const dir of ADR_DIRS) {
    const abs = pathJoin(cwd, dir);
    if (!exists(abs)) continue;
    for (const f of walkSourceFiles(abs, { exts: [".md"] })) {
      const adr = parseAdr(read(f, "utf-8"));
      if (adr) out.push({ adr, file: rel(cwd, f) });
    }
  }
  return out;
}

/**
 * Stable identity of a finding for baselining — deliberately EXCLUDES the line number so an
 * unrelated edit that shifts lines does not silently un-freeze (or re-raise) a known finding.
 */
export function adrFindingKey(v: AdrViolation): string {
  return `${v.adrId}|${v.rule}|${v.file}|${v.detail}`;
}

export interface AdrFindings {
  adrCount: number;
  enforcedCount: number;
  violations: AdrViolation[];
  gaps: AdrViolation[];
}

/** Gather every accepted ADR's findings over the repo. Pure-ish (reads the repo, no gating). */
export function collectAdrFindings(cwd: string): AdrFindings {
  const adrs = loadAdrs(cwd);
  const files = walkSourceFiles(cwd, { exts: CODE_EXTS, includeTests: true }).map((f) => ({
    path: rel(cwd, f),
    content: read(f, "utf-8"),
  }));
  const violations: AdrViolation[] = [];
  const gaps: AdrViolation[] = [];
  let enforcedCount = 0;
  // One resolver per run: its caches are what make a cross-package walk affordable. Rules
  // without `follow_packages` never call it, so this costs nothing when nobody opted in.
  const packages = createNodeModulesResolver(cwd);
  for (const { adr } of adrs) {
    if (!adrIsEnforced(adr)) continue;
    enforcedCount++;
    for (const v of evaluateAdr(adr, files, { packages })) {
      (v.kind === "gap" ? gaps : violations).push(v);
    }
  }
  return { adrCount: adrs.length, enforcedCount, violations, gaps };
}

/** Snapshot current ADR violations + gaps into the baseline. Returns the number frozen. */
export function freezeAdrBaseline(baseline: Baseline, cwd: string): number {
  const { violations, gaps } = collectAdrFindings(cwd);
  const vKeys = violations.map(adrFindingKey);
  const gKeys = gaps.map(adrFindingKey);
  baselineSet(baseline, BASELINE_CATEGORY, "violations", vKeys);
  baselineSet(baseline, BASELINE_CATEGORY, "gaps", gKeys);
  return vKeys.length + gKeys.length;
}

/** Structured result of the ADR gate — what runAdrGate computes and every surface renders. */
export interface AdrGateResult {
  ok: boolean;
  adrCount: number;
  enforcedCount: number;
  /** Net-new (not baseline-frozen) violations / unprovable rules. */
  violations: AdrViolation[];
  gaps: AdrViolation[];
  /** How many findings the baseline suppressed. */
  suppressed: number;
  baselineIgnored: string | null;
}

/**
 * The ADR gate core: loads the baseline (fail-open on a corrupt file — a baseline only
 * ever SUPPRESSES, so an unreadable one gates on everything), suppresses frozen findings,
 * and returns the structured verdict. No printing — adrCheck (CLI) and `kit review`'s
 * ADR stage (collectReview) both consume this, so the surfaces can't diverge.
 */
export async function runAdrGate(cwd = process.cwd()): Promise<AdrGateResult> {
  const adrs = loadAdrs(cwd);
  if (adrs.length === 0) {
    return {
      ok: true,
      adrCount: 0,
      enforcedCount: 0,
      violations: [],
      gaps: [],
      suppressed: 0,
      baselineIgnored: null,
    };
  }

  const { loadBaselineForGate, baselineGet } = await import("../baseline.js");
  const { baseline, ignored } = await loadBaselineForGate(cwd);
  const frozen = new Set([
    ...baselineGet(baseline, BASELINE_CATEGORY, "violations"),
    ...baselineGet(baseline, BASELINE_CATEGORY, "gaps"),
  ]);

  const { enforcedCount, violations, gaps } = collectAdrFindings(cwd);
  const liveViolations = violations.filter((v) => !frozen.has(adrFindingKey(v)));
  const liveGaps = gaps.filter((v) => !frozen.has(adrFindingKey(v)));
  const suppressed = violations.length - liveViolations.length + (gaps.length - liveGaps.length);
  // No enforced ADR ⇒ nothing to gate (documented, not enforced) — ok by definition.
  const ok = enforcedCount === 0 || (liveViolations.length === 0 && liveGaps.length === 0);
  return {
    ok,
    adrCount: adrs.length,
    enforcedCount,
    violations: liveViolations,
    gaps: liveGaps,
    suppressed,
    baselineIgnored: ignored,
  };
}

/**
 * The embeddable ADR gate, rendered. Prints runAdrGate's verdict and returns ok.
 * Shared by `kit adr check` and the pre-commit hook (`kit review` renders the
 * structured result itself via collectReview).
 */
export async function adrCheck(cwd = process.cwd()): Promise<boolean> {
  const {
    ok,
    adrCount,
    enforcedCount,
    violations: liveViolations,
    gaps: liveGaps,
    suppressed,
    baselineIgnored,
  } = await runAdrGate(cwd);
  if (adrCount === 0) {
    console.log(
      `${c.dim}No ADRs found in ${ADR_DIRS.join(" or ")}. Add one with a --- frontmatter (id/title/status) and a \`\`\`toml kit-enforce block.${c.reset}`,
    );
    return true;
  }
  if (baselineIgnored) {
    const { BASELINE_FILE } = await import("../baseline.js");
    console.log(
      `${c.yellow}!${c.reset} ${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings`,
    );
  }

  for (const v of liveViolations) {
    console.log(
      `${c.red}✗${c.reset} ${v.file}:${v.line}  ${v.message}  ${c.dim}(${v.adrId})${c.reset}`,
    );
  }
  for (const v of liveGaps) {
    console.log(
      `${c.yellow}?${c.reset} ${v.file}:${v.line}  ${v.message}  ${c.dim}(${v.adrId})${c.reset}`,
    );
  }

  if (enforcedCount === 0) {
    console.log(
      `${c.yellow}No accepted ADR carries an enforce block — nothing to gate (documented, not enforced).${c.reset}`,
    );
    return true;
  }
  const suffix = suppressed ? ` ${c.dim}(${suppressed} baselined)${c.reset}` : "";
  if (ok) {
    console.log(
      `${c.green}✓ ${enforcedCount} enforced ADR(s) — no new violations${c.reset}${suffix}`,
    );
    return true;
  }
  const parts: string[] = [];
  if (liveViolations.length) parts.push(`${liveViolations.length} violation(s)`);
  if (liveGaps.length) parts.push(`${liveGaps.length} unprovable rule(s) (unresolved imports)`);
  console.log(
    `\n${c.red}${parts.join(" + ")} across ${enforcedCount} enforced ADR(s).${c.reset}${suffix}`,
  );
  return false;
}

export async function cmdAdr(): Promise<boolean> {
  const args = process.argv.slice(3);
  const sub =
    args[0] === "list" || args[0] === "check" || args[0] === "freeze"
      ? args[0]
      : args[0]
        ? "help"
        : "check";
  const cwd = process.cwd();

  if (sub === "help") {
    console.log(`${c.bold}kit adr${c.reset} — enforce architecture decisions (ADR → gate)\n`);
    console.log("  kit adr list     ADRs + status + enforced/documented");
    console.log("  kit adr check    gate the repo on accepted ADRs' rules (default)");
    console.log("  kit adr freeze   snapshot current findings into the baseline");
    return true;
  }

  if (sub === "list") {
    const adrs = loadAdrs(cwd);
    if (adrs.length === 0) {
      console.log(`${c.dim}No ADRs found in ${ADR_DIRS.join(" or ")}.${c.reset}`);
      return true;
    }
    console.log(`${c.bold}ADRs${c.reset}`);
    for (const { adr, file } of adrs) {
      const state = adrIsEnforced(adr)
        ? `${c.green}enforced (${adr.rules.length} rule${adr.rules.length === 1 ? "" : "s"})${c.reset}`
        : adr.status === "accepted"
          ? `${c.yellow}documented, not enforced${c.reset}`
          : `${c.dim}${adr.status}${c.reset}`;
      console.log(`  ${adr.id}  ${adr.title}  [${state}]  ${c.dim}${file}${c.reset}`);
    }
    return true;
  }

  if (sub === "freeze") {
    const { loadBaseline, saveBaseline, BASELINE_FILE } = await import("../baseline.js");
    const baseline = await loadBaseline(cwd);
    const total = freezeAdrBaseline(baseline, cwd);
    await saveBaseline(baseline, cwd);
    console.log(
      `${c.green}✓${c.reset} Wrote ${BASELINE_FILE} — ${total} ADR finding(s) frozen. Future runs gate only on NEW findings.`,
    );
    return true;
  }

  return adrCheck(cwd);
}
