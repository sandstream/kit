/**
 * kit standards — P3: user-defined plugins (the subjective / org-specific rules).
 *
 * kit ships NO opinionated standards; a team encodes "our way" as plugins that
 * follow a fixed, deterministic contract. This module covers the DECLARATIVE case
 * (the common one): a TOML file describing a ripgrep-style rule.
 *
 *   # .kit/standards.d/no-console.toml
 *   [standard]
 *   id = "no-console-in-src"
 *   title = "No console.* in shipped code"
 *   applies_to = ["typescript"]     # language gate (omit ⇒ all languages)
 *   severity = "warn"               # warn | fail  (fail = author opts into gating)
 *   mode = "forbid"                 # forbid | require  (omit ⇒ forbid)
 *   match = 'console\.(log|debug)\('
 *   exclude = ["scripts/", "fixtures/**"]     # glob patterns; trailing / means subtree
 *
 *   # Require-mode example: every file containing `scope` must also contain `match`.
 *   # Still deterministic and zero-LLM: regex over repo files, no plugin code.
 *   # mode = "require"
 *   # scope = 'export const \w+ = onCall'
 *   # match = '@apiPermission'
 *
 * Security / determinism (reusing patterns already shipped):
 *   - Schema-validated at load; a malformed plugin FAILS CLOSED — it is ignored and
 *     surfaces a `plugin integrity` warning, never crashing the gate (the lesson from
 *     the .kit-baseline.json crash fix).
 *   - Deterministic by construction: a regex over the repo's own files is a pure
 *     function of the repo. A ReDoS-prone `match` (nested unbounded quantifier) is REJECTED at
 *     load (never run); line length is additionally capped as defense-in-depth.
 *   - Net-new gating on stable `plugin/<id>:<file>:<line>` keys, same as every other
 *     standards dimension.
 *
 * Programmatic (*.mjs) plugins are handled separately (standards-plugins-exec.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { walkSourceFiles } from "./source-walk.js";
import type { StandardsCheckResult } from "./check-standards.js";

/** Default discovery directory (overridable via [standards.plugins].dirs). */
export const DEFAULT_PLUGIN_DIR = ".kit/standards.d";

/** Source extensions a declarative plugin scans when it doesn't specify its own. */
const DEFAULT_PLUGIN_EXTS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cs",
];

/** Longest line a plugin regex is run against — bounds a pathological (ReDoS) pattern. */
const MAX_LINE_LEN = 2000;

const PLUGIN_SKIP_DIRS = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".git",
  "coverage",
  "vendor",
  "target",
];

const pluginSchema = z
  .object({
    standard: z
      .object({
        id: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be kebab-case (a-z, 0-9, -)"),
        title: z.string().min(1),
        applies_to: z.array(z.string()).optional(),
        kind: z.enum(["general", "specific"]).optional(),
        severity: z.enum(["warn", "fail"]).optional(),
        mode: z.enum(["forbid", "require"]).optional(),
        scope: z.string().min(1).optional(),
        match: z.string().min(1),
        exclude: z.array(z.string()).optional(),
        include_tests: z.boolean().optional(),
        exts: z.array(z.string()).optional(),
      })
      .strict(), // reject unknown keys so a typo'd rule fails loudly, not silently
  })
  .strict();

export interface StandardPluginSpec {
  id: string;
  title: string;
  appliesTo?: string[];
  severity: "warn" | "fail";
  mode: "forbid" | "require";
  /** Require-mode scope regex: files with at least one scope match must contain `match`. */
  scope?: string;
  match: string;
  exclude: string[];
  includeTests: boolean;
  exts: string[];
  /** Source file the plugin was loaded from (for diagnostics). */
  source: string;
}

/** Stable baseline key for a plugin finding. */
export const pluginKey = (id: string, file: string, line: number): string =>
  `plugin/${id}:${file}:${line}`;

export interface LoadPluginsResult {
  plugins: StandardPluginSpec[];
  /** Fail-closed diagnostics for malformed plugins (already StandardsCheckResults). */
  integrity: StandardsCheckResult[];
}

function integrityWarn(source: string, reason: string): StandardsCheckResult {
  return {
    category: "standards",
    dimension: "plugin",
    name: `plugin integrity: ${source}`,
    status: "warn",
    severity: "low",
    detail: `ignored malformed standards plugin — ${reason}`,
  };
}

/**
 * Load + validate every declarative plugin under `dirs`. Never throws: a malformed
 * plugin becomes an integrity warning and is skipped. A bad `match` regex is caught
 * at load (compiled here) so evaluation can't blow up later.
 */
export function loadStandardPlugins(cwd: string, dirs: string[]): LoadPluginsResult {
  const plugins: StandardPluginSpec[] = [];
  const integrity: StandardsCheckResult[] = [];
  for (const dir of dirs) {
    const abs = join(cwd, dir);
    if (!existsSync(abs)) continue;
    let files: string[];
    try {
      files = walkSourceFiles(abs, { exts: [".toml"], includeTests: true });
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = relative(cwd, file);
      let raw: unknown;
      try {
        raw = parseToml(readFileSync(file, "utf8"));
      } catch (e) {
        integrity.push(integrityWarn(rel, `invalid TOML (${(e as Error).message})`));
        continue;
      }
      const parsed = pluginSchema.safeParse(raw);
      if (!parsed.success) {
        integrity.push(integrityWarn(rel, parsed.error.issues[0]?.message ?? "schema mismatch"));
        continue;
      }
      const s = parsed.data.standard;
      // Compile the regex now so a bad pattern is a load-time integrity warning.
      try {
        new RegExp(s.match);
      } catch (e) {
        integrity.push(integrityWarn(rel, `invalid match regex (${(e as Error).message})`));
        continue;
      }
      // Reject a ReDoS-prone pattern (nested unbounded quantifier) at LOAD — never compile it into
      // the per-line evaluator, where a crafted plugin could hang `kit check` with catastrophic
      // backtracking. Fail closed: the plugin is dropped with an integrity warning.
      if (hasReDoSRisk(s.match)) {
        integrity.push(
          integrityWarn(
            rel,
            `match regex is ReDoS-prone (nested quantifier) — rejected: ${s.match}`,
          ),
        );
        continue;
      }
      if (s.scope) {
        try {
          new RegExp(s.scope);
        } catch (e) {
          integrity.push(integrityWarn(rel, `invalid scope regex (${(e as Error).message})`));
          continue;
        }
        if (hasReDoSRisk(s.scope)) {
          integrity.push(
            integrityWarn(
              rel,
              `scope regex is ReDoS-prone (nested quantifier) — rejected: ${s.scope}`,
            ),
          );
          continue;
        }
      }
      plugins.push({
        id: s.id,
        title: s.title,
        appliesTo: s.applies_to,
        severity: s.severity ?? "warn",
        mode: s.mode ?? "forbid",
        scope: s.scope,
        match: s.match,
        exclude: (s.exclude ?? []).map(normalizeGlobPattern),
        includeTests: s.include_tests ?? false,
        exts: s.exts ?? DEFAULT_PLUGIN_EXTS,
        source: rel,
      });
    }
  }
  // Reject duplicate ids (two plugins with the same id → ambiguous baseline keys).
  const byId = new Map<string, StandardPluginSpec>();
  for (const p of plugins) {
    const prior = byId.get(p.id);
    if (prior) {
      integrity.push(
        integrityWarn(
          p.source,
          `duplicate plugin id '${p.id}' (already defined in ${prior.source})`,
        ),
      );
      continue;
    }
    byId.set(p.id, p);
  }
  return { plugins: [...byId.values()], integrity };
}

function normalizeGlobPattern(glob: string): string {
  return glob.endsWith("/") ? `${glob}**` : glob;
}

/** Minimal glob → RegExp: supports `**`, `*`, `?` and literal path segments. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const normalized = normalizeGlobPattern(glob);
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        re += ".*";
        i++;
        if (normalized[i + 1] === "/") i++; // `**/` matches zero or more dirs
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Length of an UNBOUNDED quantifier token at position i, else 0. `*`, `+`, `{n,}` are unbounded
 *  (catastrophic when nested); `?`, `{n}`, `{n,m}` are bounded (safe). Absorbs a lazy/possessive
 *  suffix so `*?`/`+?`/`*+` isn't mis-read as a second quantifier. */
function unboundedQuantLen(p: string, i: number): number {
  const ch = p[i];
  if (ch === "*" || ch === "+") return p[i + 1] === "?" || p[i + 1] === "+" ? 2 : 1;
  if (ch === "{") {
    const m = /^\{\d*,\}/.exec(p.slice(i)); // {n,} (unbounded upper); {n} / {n,m} do NOT match
    if (m) return p[i + m[0].length] === "?" ? m[0].length + 1 : m[0].length;
  }
  return 0;
}

/**
 * Conservative ReDoS-shape detector: true when the pattern applies an UNBOUNDED quantifier to a
 * group whose body ALSO contains an unbounded quantifier — the classic exponential-backtracking
 * shape (`(a+)+`, `(\d*)*`, `(a+)*$`, `((ab)+)+`). Deterministic, dependency-free. Assumes the
 * pattern is already syntactically valid (call after `new RegExp` succeeds). Honest limit: it
 * catches the nested-quantifier class (the common, cited ReDoS), not every catastrophic regex
 * (e.g. overlapping alternation `(a|a)+`) — those stay bounded only by MAX_LINE_LEN.
 */
export function hasReDoSRisk(pattern: string): boolean {
  const bodyHadUnbounded: boolean[] = []; // per currently-open group: has its body seen `*`/`+`/`{n,}`?
  const markParent = (): void => {
    if (bodyHadUnbounded.length > 0) bodyHadUnbounded[bodyHadUnbounded.length - 1] = true;
  };
  let inClass = false; // inside [...] — parens/quantifiers are literal there
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++; // escaped char → literal, skip it
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      bodyHadUnbounded.push(false);
      continue;
    }
    if (ch === ")") {
      const inner = bodyHadUnbounded.pop() ?? false;
      const qlen = unboundedQuantLen(pattern, i + 1);
      if (qlen > 0) {
        if (inner) return true; // (…unbounded…) followed by an unbounded quantifier → ReDoS
        markParent(); // the quantified group is itself an unbounded atom in the parent's body
        i += qlen;
      }
      continue;
    }
    const qlen = unboundedQuantLen(pattern, i);
    if (qlen > 0) {
      markParent();
      i += qlen - 1; // -1: the loop's i++ advances the last char
    }
  }
  return false;
}

export interface PluginFinding {
  file: string;
  line: number;
}

export interface PluginEvaluation {
  findings: PluginFinding[];
  warnings: StandardsCheckResult[];
}

function pluginWarn(spec: StandardPluginSpec, reason: string): StandardsCheckResult {
  return {
    category: "standards",
    dimension: "plugin",
    name: `plugin: ${spec.id}`,
    status: "warn",
    severity: "low",
    detail: reason,
  };
}

function lineMatches(lines: string[], re: RegExp): boolean {
  for (const line of lines) {
    if (line.length > MAX_LINE_LEN) continue;
    if (re.test(line)) return true;
  }
  return false;
}

/** Run one plugin's regex over the applicable source files. Pure w.r.t. the repo. */
export function evaluatePlugin(cwd: string, spec: StandardPluginSpec): PluginEvaluation {
  const matchRe = new RegExp(spec.match);
  const scopeRe = spec.scope ? new RegExp(spec.scope) : null;
  const excludes = spec.exclude.map((pattern) => ({
    pattern,
    re: globToRegExp(pattern),
    matches: 0,
  }));
  const findings: PluginFinding[] = [];
  const warnings: StandardsCheckResult[] = [];
  const files = walkSourceFiles(cwd, {
    exts: spec.exts,
    includeTests: spec.includeTests,
    skipDirs: PLUGIN_SKIP_DIRS,
  });

  if (excludes.length > 0) {
    const excludeUniverse = walkSourceFiles(cwd, {
      exts: spec.exts,
      includeTests: true,
      skipDirs: PLUGIN_SKIP_DIRS,
    });
    for (const file of excludeUniverse) {
      const rel = relative(cwd, file);
      for (const ex of excludes) {
        if (ex.re.test(rel)) ex.matches++;
      }
    }
  }

  let scopedFiles = 0;
  for (const file of files) {
    const rel = relative(cwd, file);
    if (excludes.some((ex) => ex.re.test(rel))) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    if (spec.mode === "require") {
      const inScope = scopeRe ? lineMatches(lines, scopeRe) : true;
      if (!inScope) continue;
      scopedFiles++;
      if (!lineMatches(lines, matchRe)) findings.push({ file: rel, line: 1 });
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > MAX_LINE_LEN) continue;
      if (matchRe.test(line)) findings.push({ file: rel, line: i + 1 });
    }
  }

  const unmatchedExcludes = excludes.filter((ex) => ex.matches === 0).map((ex) => ex.pattern);
  if (files.length > 0 && unmatchedExcludes.length > 0) {
    warnings.push(
      pluginWarn(spec, `exclude pattern(s) matched zero files: ${unmatchedExcludes.join(", ")}`),
    );
  }
  if (spec.mode === "require" && scopeRe && files.length > 0 && scopedFiles === 0) {
    warnings.push(pluginWarn(spec, `scope regex matched zero files: ${spec.scope}`));
  }

  return { findings, warnings };
}

/** Back-compatible convenience wrapper used by tests and baseline collection. */
export function evaluatePluginFindings(cwd: string, spec: StandardPluginSpec): PluginFinding[] {
  return evaluatePlugin(cwd, spec).findings;
}

function pluginPassDetail(spec: StandardPluginSpec): string {
  return spec.mode === "require"
    ? `${spec.title} — required pattern present in scoped files`
    : `${spec.title} — no matches`;
}

function pluginFreshDetail(spec: StandardPluginSpec, fresh: number, total: number): string {
  return spec.mode === "require"
    ? `${spec.title} — ${fresh} file(s) missing required pattern (${total} total)`
    : `${spec.title} — ${fresh} new match(es) (${total} total)`;
}

function pluginFileLabel(spec: StandardPluginSpec, f: PluginFinding): string {
  return spec.mode === "require" ? `${f.file}:missing` : `${f.file}:${f.line}`;
}

export interface CheckPluginsOptions {
  cwd?: string;
  language: string;
  enforce?: boolean;
  dirs?: string[];
  baseline?: string[];
}

/**
 * Evaluate every applicable declarative plugin → StandardsCheckResult[]. A plugin
 * whose `applies_to` excludes the detected language is skipped. Net-new findings warn
 * by default; they FAIL when the plugin declares `severity = "fail"` OR under
 * `--enforce`. Malformed plugins surface as integrity warnings (fail-closed).
 */
export function checkStandardsPlugins(opts: CheckPluginsOptions): StandardsCheckResult[] {
  const cwd = opts.cwd ?? process.cwd();
  const enforce = opts.enforce ?? false;
  const dirs = opts.dirs ?? [DEFAULT_PLUGIN_DIR];
  const seen = new Set(opts.baseline ?? []);
  const { plugins, integrity } = loadStandardPlugins(cwd, dirs);
  const results: StandardsCheckResult[] = [...integrity];

  for (const spec of plugins) {
    if (spec.appliesTo && spec.appliesTo.length > 0 && !spec.appliesTo.includes(opts.language)) {
      continue;
    }
    const evaluation = evaluatePlugin(cwd, spec);
    results.push(...evaluation.warnings);
    const findings = evaluation.findings;
    const fresh = findings.filter((f) => !seen.has(pluginKey(spec.id, f.file, f.line)));
    const name = `plugin: ${spec.id}`;
    const gates = enforce || spec.severity === "fail";
    if (findings.length === 0) {
      results.push({
        category: "standards",
        dimension: "plugin",
        name,
        status: "pass",
        detail: pluginPassDetail(spec),
      });
    } else if (fresh.length === 0) {
      results.push({
        category: "standards",
        dimension: "plugin",
        name,
        status: "warn",
        severity: "low",
        detail: `${findings.length} pre-existing match(es) (baseline-frozen)`,
      });
    } else {
      results.push({
        category: "standards",
        dimension: "plugin",
        name,
        status: gates ? "fail" : "warn",
        severity: gates ? "high" : "medium",
        detail: pluginFreshDetail(spec, fresh.length, findings.length),
        files: fresh.slice(0, 10).map((f) => pluginFileLabel(spec, f)),
      });
    }
  }
  return results;
}

/** Snapshot current plugin matches for `kit baseline freeze` (net-new thereafter). */
export function collectPluginKeys(cwd: string, language: string, dirs?: string[]): string[] {
  const { plugins } = loadStandardPlugins(cwd, dirs ?? [DEFAULT_PLUGIN_DIR]);
  const keys: string[] = [];
  for (const spec of plugins) {
    if (spec.appliesTo && spec.appliesTo.length > 0 && !spec.appliesTo.includes(language)) continue;
    for (const f of evaluatePluginFindings(cwd, spec))
      keys.push(pluginKey(spec.id, f.file, f.line));
  }
  return keys;
}
