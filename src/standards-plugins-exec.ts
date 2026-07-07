/**
 * kit standards — P3 (programmatic): `*.mjs` plugins in a restricted context.
 *
 * A declarative TOML rule can't express everything, so a plugin may instead be an
 * ES module exporting `evaluate(ctx)` (plus `id` / `title` / `severity` / `appliesTo`
 * metadata). Because that is arbitrary code, it runs under a deliberately narrow
 * contract:
 *
 *   - RESTRICTED CONTEXT: executed in a fresh `node` child process with a stripped
 *     env (an ALLOWLIST — PATH/HOME/lang only; NO secret-shaped vars ever), so a
 *     plugin can't read the operator's credentials. Stricter than the sync
 *     transport's deny-list, because this is code, not a fixed command.
 *   - HARD TIMEOUT: a hung/infinite plugin is killed, not the gate.
 *   - DETERMINISM VERIFY: kit runs the plugin TWICE and rejects it (integrity warn)
 *     if the two outputs differ — a standards gate must be a pure function of the
 *     repo. This is the same determinism discipline validated on `kit check`.
 *   - SCHEMA VALIDATED: the plugin's output is parsed against a fixed schema; a
 *     malformed result fails closed (ignored + integrity warn), never crashes.
 *
 * Honest scope note: env-stripping + child isolation + determinism + schema is the
 * bar the plan sets ("same env-stripping as the sync transport"). Node cannot block
 * outbound network from a plain child, so a plugin still runs with roughly the trust
 * of a dev dependency / npm script — it is code the repo owner placed in the tree.
 * Treat third-party standards plugins with the same care as any dependency.
 *
 * The child harness (HARNESS below) imports the plugin, calls `evaluate(ctx)`, and
 * prints a single JSON line. kit only ever sees that JSON — the plugin's module
 * scope never touches kit's process.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { walkSourceFiles } from "./source-walk.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { pluginKey } from "./standards-plugins.js";
import type { StandardsCheckResult } from "./check-standards.js";

/** Env vars the plugin child is allowed to see — everything else (incl. all secrets) is dropped. */
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_PATH"];

/** Per-plugin wall-clock budget. */
const PLUGIN_TIMEOUT_MS = 15_000;

const outputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    severity: z.enum(["warn", "fail"]).optional(),
    appliesTo: z.array(z.string()).optional(),
    findings: z
      .array(
        z.object({
          file: z.string().min(1),
          line: z.number().int().positive().optional(),
          message: z.string().optional(),
        }),
      )
      .max(10_000),
  })
  .strict();

export type PluginOutput = z.infer<typeof outputSchema>;

// The child harness. It imports the plugin as an ES module, calls evaluate(ctx),
// normalizes the result, and prints ONE JSON line prefixed with a sentinel so kit
// can ignore any incidental stdout the plugin emitted.
const SENTINEL = "__KIT_STD_PLUGIN__";
const HARNESS = `
import { pathToFileURL } from "node:url";
const [pluginPath, ctxJson] = process.argv.slice(2);
const ctx = JSON.parse(ctxJson);
const mod = await import(pathToFileURL(pluginPath).href);
const evaluate = mod.evaluate ?? mod.default;
if (typeof evaluate !== "function") {
  console.error("plugin has no evaluate(ctx) export");
  process.exit(3);
}
const raw = await evaluate(ctx);
const findings = Array.isArray(raw) ? raw : (raw && raw.findings) || [];
const out = {
  id: (raw && raw.id) || mod.id || ctx.defaultId,
  title: (raw && raw.title) || mod.title || ctx.defaultId,
  severity: (raw && raw.severity) || mod.severity,
  appliesTo: (raw && raw.appliesTo) || mod.appliesTo,
  findings: findings.map((f) => ({ file: String(f.file), line: f.line, message: f.message })),
};
process.stdout.write("${SENTINEL}" + JSON.stringify(out) + "\\n");
`;

/** Extract the sentinel JSON line from possibly-noisy child stdout. */
function extractOutput(stdout: string): unknown {
  const line = stdout.split("\n").find((l) => l.startsWith(SENTINEL));
  if (!line) throw new Error("plugin produced no result line");
  return JSON.parse(line.slice(SENTINEL.length));
}

function strippedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

/** Run one mjs plugin once in the restricted child; returns validated output. Throws on any failure. */
async function runOnce(
  cwd: string,
  pluginPath: string,
  language: string,
  harnessPath: string,
): Promise<PluginOutput> {
  const defaultId = pluginBaseName(pluginPath);
  const ctx = JSON.stringify({ cwd, language, defaultId });
  const res = await execFileNoThrow(process.execPath, [harnessPath, pluginPath, ctx], {
    timeout: PLUGIN_TIMEOUT_MS,
    env: strippedEnv(),
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!res.ok && !res.stdout.includes(SENTINEL)) {
    throw new Error(res.stderr.trim().split("\n").slice(-1)[0] || `exited ${res.exitCode}`);
  }
  const parsed = outputSchema.safeParse(extractOutput(res.stdout));
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid output shape");
  return parsed.data;
}

function pluginBaseName(p: string): string {
  return (
    p
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.mjs$/, "") ?? "plugin"
  );
}

/** Deterministic comparison of two plugin runs (order-insensitive on findings). */
function sameOutput(a: PluginOutput, b: PluginOutput): boolean {
  if (a.id !== b.id || a.title !== b.title || a.severity !== b.severity) return false;
  const norm = (o: PluginOutput) =>
    o.findings
      .map((f) => `${f.file}:${f.line ?? ""}:${f.message ?? ""}`)
      .sort()
      .join("|");
  return norm(a) === norm(b);
}

function integrityWarn(source: string, reason: string): StandardsCheckResult {
  return {
    category: "standards",
    dimension: "plugin",
    name: `plugin integrity: ${source}`,
    status: "warn",
    severity: "low",
    detail: `ignored programmatic standards plugin — ${reason}`,
  };
}

export interface MjsPluginRun {
  source: string;
  output?: PluginOutput;
  integrity?: StandardsCheckResult;
}

/** Discover + run every `*.mjs` plugin under `dirs`, each TWICE for determinism. */
export async function runMjsPlugins(
  cwd: string,
  dirs: string[],
  language: string,
): Promise<MjsPluginRun[]> {
  const runs: MjsPluginRun[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "kit-std-plugin-"));
  const harnessPath = join(tmp, "harness.mjs");
  try {
    writeFileSync(harnessPath, HARNESS, { mode: 0o600 });
    for (const dir of dirs) {
      const abs = join(cwd, dir);
      if (!existsSync(abs)) continue;
      let files: string[];
      try {
        files = walkSourceFiles(abs, { exts: [".mjs"], includeTests: true });
      } catch {
        continue;
      }
      for (const file of files) {
        const source = relative(cwd, file);
        try {
          const first = await runOnce(cwd, resolve(file), language, harnessPath);
          const second = await runOnce(cwd, resolve(file), language, harnessPath);
          if (!sameOutput(first, second)) {
            runs.push({
              source,
              integrity: integrityWarn(
                source,
                "non-deterministic: two runs produced different output (a gate must be a pure function of the repo)",
              ),
            });
            continue;
          }
          runs.push({ source, output: first });
        } catch (e) {
          runs.push({ source, integrity: integrityWarn(source, (e as Error).message) });
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return runs;
}

/** Map a validated plugin output → net-new-gated StandardsCheckResult. */
export function resultFromOutput(
  out: PluginOutput,
  enforce: boolean,
  seen: Set<string>,
): StandardsCheckResult {
  // A finding without a line can't be keyed per-line; key it by file (line 0) so it
  // stays baseline-able alongside line-anchored findings.
  const allKeys = out.findings.map((f) => pluginKey(out.id, f.file, f.line ?? 0));
  const fresh = allKeys.filter((k) => !seen.has(k));
  const name = `plugin: ${out.id}`;
  const gates = enforce || out.severity === "fail";
  if (out.findings.length === 0) {
    return {
      category: "standards",
      dimension: "plugin",
      name,
      status: "pass",
      detail: `${out.title} — no matches`,
    };
  }
  if (fresh.length === 0) {
    return {
      category: "standards",
      dimension: "plugin",
      name,
      status: "warn",
      severity: "low",
      detail: `${out.findings.length} pre-existing match(es) (baseline-frozen)`,
    };
  }
  return {
    category: "standards",
    dimension: "plugin",
    name,
    status: gates ? "fail" : "warn",
    severity: gates ? "high" : "medium",
    detail: `${out.title} — ${fresh.length} new match(es) (${out.findings.length} total)`,
    files: out.findings
      .slice(0, 10)
      .map((f) => `${f.file}${f.line ? `:${f.line}` : ""}${f.message ? ` ${f.message}` : ""}`),
  };
}

export interface CheckMjsOptions {
  cwd?: string;
  language: string;
  enforce?: boolean;
  dirs: string[];
  baseline?: string[];
}

/** Evaluate every applicable programmatic plugin → StandardsCheckResult[]. */
export async function checkStandardsMjsPlugins(
  opts: CheckMjsOptions,
): Promise<StandardsCheckResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const enforce = opts.enforce ?? false;
  const seen = new Set(opts.baseline ?? []);
  const runs = await runMjsPlugins(cwd, opts.dirs, opts.language);
  const results: StandardsCheckResult[] = [];
  for (const run of runs) {
    if (run.integrity) {
      results.push(run.integrity);
      continue;
    }
    const out = run.output;
    if (!out) continue;
    if (out.appliesTo && out.appliesTo.length > 0 && !out.appliesTo.includes(opts.language))
      continue;
    results.push(resultFromOutput(out, enforce, seen));
  }
  return results;
}

/** Snapshot programmatic-plugin matches for `kit baseline freeze`. */
export async function collectMjsPluginKeys(
  cwd: string,
  language: string,
  dirs: string[],
): Promise<string[]> {
  const runs = await runMjsPlugins(cwd, dirs, language);
  const keys: string[] = [];
  for (const run of runs) {
    const out = run.output;
    if (!out) continue;
    if (out.appliesTo && out.appliesTo.length > 0 && !out.appliesTo.includes(language)) continue;
    for (const f of out.findings) keys.push(pluginKey(out.id, f.file, f.line ?? 0));
  }
  return keys;
}
