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
 *   match = 'console\.(log|debug)\('
 *   exclude = ["scripts/", "test fixtures"]   # glob patterns, matched on the rel path
 *
 * Security / determinism (reusing patterns already shipped):
 *   - Schema-validated at load; a malformed plugin FAILS CLOSED — it is ignored and
 *     surfaces a `plugin integrity` warning, never crashing the gate (the lesson from
 *     the .kit-baseline.json crash fix).
 *   - Deterministic by construction: a regex over the repo's own files is a pure
 *     function of the repo. Line length is capped to bound pathological regexes.
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
      plugins.push({
        id: s.id,
        title: s.title,
        appliesTo: s.applies_to,
        severity: s.severity ?? "warn",
        match: s.match,
        exclude: s.exclude ?? [],
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

/** Minimal glob → RegExp: supports `**`, `*`, `?` and literal path segments. */
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
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

function isExcluded(relFile: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(relFile));
}

export interface PluginFinding {
  file: string;
  line: number;
}

/** Run one plugin's regex over the applicable source files. Pure w.r.t. the repo. */
export function evaluatePluginFindings(cwd: string, spec: StandardPluginSpec): PluginFinding[] {
  const re = new RegExp(spec.match);
  const excludes = spec.exclude.map(globToRegExp);
  const findings: PluginFinding[] = [];
  const files = walkSourceFiles(cwd, {
    exts: spec.exts,
    includeTests: spec.includeTests,
    skipDirs: [
      "node_modules",
      "dist",
      "build",
      "out",
      ".next",
      ".git",
      "coverage",
      "vendor",
      "target",
    ],
  });
  for (const file of files) {
    const rel = relative(cwd, file);
    if (isExcluded(rel, excludes)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > MAX_LINE_LEN) continue;
      if (re.test(line)) findings.push({ file: rel, line: i + 1 });
    }
  }
  return findings;
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
    const findings = evaluatePluginFindings(cwd, spec);
    const fresh = findings.filter((f) => !seen.has(pluginKey(spec.id, f.file, f.line)));
    const name = `plugin: ${spec.id}`;
    const gates = enforce || spec.severity === "fail";
    if (findings.length === 0) {
      results.push({
        category: "standards",
        dimension: "plugin",
        name,
        status: "pass",
        detail: `${spec.title} — no matches`,
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
        detail: `${spec.title} — ${fresh.length} new match(es) (${findings.length} total)`,
        files: fresh.slice(0, 10).map((f) => `${f.file}:${f.line}`),
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
