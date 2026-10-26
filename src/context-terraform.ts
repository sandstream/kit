import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ContextConfig } from "./config.js";
import type { ContextFinding } from "./context-lock.js";

/**
 * Terraform context lock. The state backend and the workspace are recorded by `terraform init`
 * in `.terraform/`, so they are read from there as plain files. kit never runs `terraform`.
 * Declared values are exact names, never patterns.
 */
const MAX_STATE_BYTES = 1024 * 1024;
const TOOL = "terraform";

interface Live {
  bucket: string | null;
  prefix: string | null;
  workspace: string | null;
}

const NOTHING: Live = { bucket: null, prefix: null, workspace: null };

/** The declared directory resolved inside the repository, or null when it leaves it. */
function insideRepo(cwd: string, dir: string | undefined): string | null {
  if (dir !== undefined && isAbsolute(dir)) return null;
  const root = realpathSync(cwd);
  const target = resolve(root, dir ?? ".");
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  if (!existsSync(target)) return target;
  const real = realpathSync(target);
  const back = relative(root, real);
  return back.startsWith("..") || isAbsolute(back) ? null : real;
}

function text(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function readJson(path: string): unknown {
  try {
    if (statSync(path).size > MAX_STATE_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readLive(dir: string): Live {
  const tf = join(dir, ".terraform");
  if (!existsSync(tf)) return NOTHING;
  const state = readJson(join(tf, "terraform.tfstate")) as {
    backend?: { config?: Record<string, unknown> };
  } | null;
  const cfg = state?.backend?.config;
  let workspace = "default";
  try {
    workspace = readFileSync(join(tf, "environment"), "utf8").trim() || "default";
  } catch {
    // no environment file: terraform uses the default workspace
  }
  return { bucket: text(cfg?.bucket), prefix: text(cfg?.prefix), workspace };
}

function row(field: keyof Live, expected: string, live: Live): ContextFinding {
  const actual = live[field];
  const status = actual === null ? "unknown" : actual === expected ? "ok" : "mismatch";
  return { tool: TOOL, field, status, expected, actual };
}

/** Findings for a declared `[context.terraform]` block. Empty when nothing is declared. */
export function terraformFindings(
  ctx: ContextConfig | undefined,
  cwd: string = process.cwd(),
): ContextFinding[] {
  const t = ctx?.terraform;
  if (!t) return [];
  const dir = insideRepo(cwd, t.dir);
  if (dir === null) {
    return [
      {
        tool: TOOL,
        field: "dir",
        status: "mismatch",
        expected: "a directory inside the repository",
        actual: t.dir ?? null,
      },
    ];
  }
  const live = readLive(dir);
  const out: ContextFinding[] = [];
  for (const f of ["bucket", "prefix", "workspace"] as const) {
    const expected = t[f];
    if (expected !== undefined) out.push(row(f, expected, live));
  }
  return out;
}
