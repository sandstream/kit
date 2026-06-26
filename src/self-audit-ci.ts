// Class 11 analyzer for `kit self-audit`: CI script-path integrity.
//
// GitHub Actions workflows reference helper scripts by path (`node scripts/x.mjs`,
// `python3 skills/.../triage.py`) or by npm script name (`npm run build`). When a
// script is renamed/moved but a workflow still points at the old path, CI silently
// skips the step in some cases or hard-fails in others — and the gap isn't visible
// until that workflow runs. This analyzer resolves every such reference statically:
// file refs must exist on disk; npm-run refs must be defined in package.json.
//
// Pure + deterministic: no network, no LLM. extractScriptRefs/resolveNpmScript are
// the testable units; runCiScriptAudit is the filesystem-bound orchestrator.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

/** Category used for every result this analyzer emits. */
const CI_CATEGORY: SecurityCheckResult["category"] = "self-audit/ci-script-paths";

export interface ScriptRef {
  kind: "node" | "python" | "npm";
  ref: string;
  line: number;
  file: string;
}

// Matchers applied to each line of a workflow's `run:` bodies. We don't parse YAML —
// `run:` blocks are free-form shell, so a line scan is both simpler and more robust
// than trying to model the step structure. `${{ ... }}` interpolation (matrix/env)
// is skipped: the resolved value isn't knowable statically, so a literal path check
// would produce false positives.
const NODE_RE = /node\s+(scripts\/[\w./-]+)/;
const PYTHON_RE = /python\d?\s+([\w./-]+\.py)/;
const NPM_RUN_RE = /\b(?:npm|pnpm)\s+run\s+([\w:-]+)/;

/**
 * Extract script references from a workflow YAML's text. Line-scanned so each ref
 * carries an accurate 1-based line number for annotations. Any ref whose captured
 * value contains `${{` is dropped (unresolvable interpolation).
 */
export function extractScriptRefs(workflowText: string, file: string): ScriptRef[] {
  const refs: ScriptRef[] = [];
  const lines = workflowText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const node = NODE_RE.exec(line);
    if (node && !node[1].includes("${{")) {
      refs.push({ kind: "node", ref: node[1], line: lineNo, file });
    }

    const python = PYTHON_RE.exec(line);
    if (python && !python[1].includes("${{")) {
      refs.push({ kind: "python", ref: python[1], line: lineNo, file });
    }

    const npm = NPM_RUN_RE.exec(line);
    if (npm && !npm[1].includes("${{")) {
      refs.push({ kind: "npm", ref: npm[1], line: lineNo, file });
    }
  }

  return refs;
}

/** True when `name` is a defined npm script. */
export function resolveNpmScript(name: string, pkgScripts: Record<string, string>): boolean {
  return name in pkgScripts;
}

/** Read package.json `scripts` map; tolerate a missing/malformed file (empty map). */
function readPkgScripts(repoRoot: string): Record<string, string> {
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "scripts" in parsed) {
      const scripts = (parsed as { scripts?: unknown }).scripts;
      if (scripts && typeof scripts === "object") {
        return scripts as Record<string, string>;
      }
    }
  } catch {
    // Malformed package.json: treat as no scripts so npm-run refs surface as findings
    // rather than the whole audit crashing.
  }
  return {};
}

/** List workflow files under .github/workflows (*.yml, *.yaml). */
function listWorkflows(repoRoot: string): string[] {
  const dir = join(repoRoot, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")))
    .map((e) => join(dir, e.name));
}

/**
 * Audit every script reference across the repo's GitHub Actions workflows.
 *
 * - node/python refs must exist on disk (relative to repoRoot).
 * - npm-run refs must be defined in repoRoot/package.json scripts.
 *
 * Each unresolved reference -> one `fail` result (severity high). When every
 * reference resolves, returns a single `pass` summarising the counts.
 */
export function runCiScriptAudit(repoRoot: string): SecurityCheckResult[] {
  const workflows = listWorkflows(repoRoot);
  if (workflows.length === 0) {
    return [
      {
        category: CI_CATEGORY,
        name: "CI script paths",
        status: "skip",
        detail: "no .github/workflows/*.{yml,yaml} found",
      },
    ];
  }

  const pkgScripts = readPkgScripts(repoRoot);
  const results: SecurityCheckResult[] = [];
  let totalRefs = 0;

  for (const file of workflows) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      results.push({
        category: CI_CATEGORY,
        name: file,
        status: "warn",
        detail: `could not read workflow: ${err instanceof Error ? err.message : String(err)}`,
        severity: "low",
        files: [file],
      });
      continue;
    }

    const refs = extractScriptRefs(text, file);
    totalRefs += refs.length;

    for (const ref of refs) {
      const resolved =
        ref.kind === "npm"
          ? resolveNpmScript(ref.ref, pkgScripts)
          : existsSync(join(repoRoot, ref.ref));

      if (!resolved) {
        results.push({
          category: CI_CATEGORY,
          name: ref.ref,
          status: "fail",
          severity: "high",
          detail:
            ref.kind === "npm"
              ? `workflow runs "npm run ${ref.ref}" but no such script in package.json (${file}:${ref.line})`
              : `workflow references ${ref.kind} script "${ref.ref}" but it does not exist on disk (${file}:${ref.line})`,
          files: [file],
          suggestion:
            ref.kind === "npm"
              ? `Add a "${ref.ref}" entry to package.json scripts, or fix the workflow reference.`
              : `Restore or move ${ref.ref}, or update the workflow to the script's new path.`,
        });
      }
    }
  }

  if (results.length === 0) {
    return [
      {
        category: CI_CATEGORY,
        name: "CI script paths",
        status: "pass",
        detail: `${totalRefs} refs across ${workflows.length} workflows all resolve`,
      },
    ];
  }

  return results;
}
