/**
 * Per-project CLI context lock.
 *
 * Verifies that each tool's LIVE (account, project) pair matches what `.kit.toml`
 * `[context]` declares. The core rule: a logged-in account and a selected project
 * are NEVER assumed to belong together. Only the declared pair is trusted; the
 * ambient CLI state is data to be checked against it. A right account paired with
 * the wrong project (or vice versa) is a mismatch, not a pass.
 *
 * Read-only: this never changes any tool's state (that is `kit context use`).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { ContextConfig } from "./config.js";

const exec = promisify(execFile);

export interface ContextFinding {
  tool: string; // gcloud | git | github | npm | vercel
  field: string; // account | project | email | org | remote | registry | ...
  status: "ok" | "mismatch" | "unknown"; // unknown = live state could not be read
  expected: string;
  actual: string | null;
}

/** A snapshot of the live context read from each tool (null = unreadable). */
export interface LiveContext {
  gcloud?: { account: string | null; project: string | null };
  git?: { email: string | null };
  github?: { org: string | null; remote: string | null };
  npm?: { registry: string | null };
  vercel?: { orgId: string | null; projectId: string | null };
}

function field(
  tool: string,
  name: string,
  expected: string | undefined,
  actual: string | null,
): ContextFinding | null {
  if (expected === undefined) return null; // not declared -> not checked
  if (actual === null) return { tool, field: name, status: "unknown", expected, actual: null };
  return { tool, field: name, status: actual === expected ? "ok" : "mismatch", expected, actual };
}

// One row per checkable (tool, field). Adding a CLI to the lock is one row.
// `declared` returns the expected value (undefined = not declared = not checked);
// `live` returns the read value (null = unreadable). vercel context = the ids in
// .vercel/project.json (deterministic + local): team -> orgId, project -> projectId.
const FIELD_SPECS: {
  tool: string;
  field: string;
  declared: (d: ContextConfig) => string | undefined;
  live: (l: LiveContext) => string | null;
}[] = [
  { tool: "gcloud", field: "account", declared: (d) => d.gcloud?.account, live: (l) => l.gcloud?.account ?? null },
  { tool: "gcloud", field: "project", declared: (d) => d.gcloud?.project, live: (l) => l.gcloud?.project ?? null },
  { tool: "git", field: "email", declared: (d) => d.git?.email, live: (l) => l.git?.email ?? null },
  { tool: "github", field: "org", declared: (d) => d.github?.org, live: (l) => l.github?.org ?? null },
  { tool: "github", field: "remote", declared: (d) => d.github?.remote, live: (l) => l.github?.remote ?? null },
  { tool: "npm", field: "registry", declared: (d) => d.npm?.registry, live: (l) => l.npm?.registry ?? null },
  { tool: "vercel", field: "team(orgId)", declared: (d) => d.vercel?.team, live: (l) => l.vercel?.orgId ?? null },
  { tool: "vercel", field: "project(projectId)", declared: (d) => d.vercel?.project, live: (l) => l.vercel?.projectId ?? null },
];

/**
 * Compare a declared context against a live snapshot. PURE (no I/O) so the
 * principle is unit-testable: only the exact declared pair passes.
 */
export function compareContext(declared: ContextConfig, live: LiveContext): ContextFinding[] {
  return FIELD_SPECS.map((s) => field(s.tool, s.field, s.declared(declared), s.live(live))).filter(
    (f): f is ContextFinding => f !== null,
  );
}

/**
 * Build a ready-to-paste `[context]` block from a live snapshot, for the
 * empty-state hint. Every value is what kit DETECTED as the currently-active
 * CLI state — which is exactly what the lock exists to question, not trust.
 * So each field is annotated with its source: git/github/vercel come from
 * repo-local truth (config, origin remote, .vercel/project.json) and are
 * authoritative; gcloud/npm are ambient/global and are flagged to verify.
 * Tools kit could not read are omitted. PURE so it is unit-testable.
 */
export function suggestContextToml(live: LiveContext): string {
  const out: string[] = [];
  const emit = (header: string, rows: [string, string | null | undefined, string][]): void => {
    const present = rows.filter(([, v]) => v);
    if (present.length === 0) return;
    out.push(header);
    for (const [k, v, note] of present) {
      out.push(`${k} = "${v}"${note ? `   # ${note}` : ""}`);
    }
    out.push("");
  };
  emit("[context.git]", [["email", live.git?.email, "this repo's git config"]]);
  emit("[context.github]", [
    ["org", live.github?.org, "from origin remote — authoritative"],
    ["remote", live.github?.remote, ""],
  ]);
  emit("[context.vercel]", [
    ["team", live.vercel?.orgId, "orgId from .vercel/project.json — authoritative"],
    ["project", live.vercel?.projectId, "projectId"],
  ]);
  emit("[context.gcloud]", [
    ["account", live.gcloud?.account, "⚠ currently-active gcloud — VERIFY it is right for THIS repo"],
    ["project", live.gcloud?.project, "⚠ verify"],
  ]);
  emit("[context.npm]", [["registry", live.npm?.registry, "global npm registry"]]);
  return out.join("\n").trimEnd();
}

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** github.com[:/]org/repo(.git) -> { org, "github.com/org/repo" }. */
export function parseGithubRemote(url: string | null): { org: string | null; remote: string | null } {
  if (!url) return { org: null, remote: null };
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return { org: null, remote: null };
  return { org: m[1], remote: `github.com/${m[1]}/${m[2]}` };
}

/** Read the live context from each tool. Every read fails soft to null. */
export async function gatherLive(cwd: string = process.cwd()): Promise<LiveContext> {
  const live: LiveContext = {};

  const gcloudJson = await run("gcloud", ["config", "list", "--format=json"]);
  if (gcloudJson !== null) {
    try {
      const c = JSON.parse(gcloudJson) as { core?: { account?: string; project?: string } };
      live.gcloud = { account: c.core?.account ?? null, project: c.core?.project ?? null };
    } catch {
      live.gcloud = { account: null, project: null };
    }
  } else {
    live.gcloud = { account: null, project: null };
  }

  live.git = { email: await run("git", ["config", "user.email"]) };

  const remote = await run("git", ["remote", "get-url", "origin"]);
  live.github = parseGithubRemote(remote);

  const registry = await run("npm", ["config", "get", "registry"]);
  live.npm = { registry: registry ? registry.replace(/\/+$/, "") : null };

  try {
    const raw = await readFile(resolve(cwd, ".vercel", "project.json"), "utf8");
    const j = JSON.parse(raw) as { orgId?: string; projectId?: string };
    live.vercel = { orgId: j.orgId ?? null, projectId: j.projectId ?? null };
  } catch {
    live.vercel = { orgId: null, projectId: null };
  }

  return live;
}

/** Verify the declared context against live tool state. Empty if nothing declared. */
export async function checkContext(
  ctx: ContextConfig | undefined,
  cwd: string = process.cwd(),
): Promise<ContextFinding[]> {
  if (!ctx) return [];
  // Normalize a declared npm registry the same way the live read is normalized.
  const declared: ContextConfig = ctx.npm?.registry
    ? { ...ctx, npm: { ...ctx.npm, registry: ctx.npm.registry.replace(/\/+$/, "") } }
    : ctx;
  return compareContext(declared, await gatherLive(cwd));
}

// ── kit context use — activate the declared context ──────────────────────────

export interface ContextStep {
  tool: string;
  argv: string[];
  /** Run in the repo (cwd) rather than affecting global state — e.g. git config. */
  local?: boolean;
  describe: string;
}

/**
 * Plan the commands that would activate the declared context. PURE (no I/O) so
 * the mapping is unit-testable. Only LOCAL CLI config is ever touched (gcloud
 * config, repo git identity) — never an account or a deploy. vercel/npm are not
 * auto-activated (no clean per-repo "active" state); `use` prints guidance.
 */
export function planContext(ctx: ContextConfig): ContextStep[] {
  const steps: ContextStep[] = [];
  const g = ctx.gcloud;
  if (g?.config)
    steps.push({ tool: "gcloud", argv: ["config", "configurations", "activate", g.config], describe: `activate config ${g.config}` });
  if (g?.account)
    steps.push({ tool: "gcloud", argv: ["config", "set", "account", g.account], describe: `account=${g.account}` });
  if (g?.project)
    steps.push({ tool: "gcloud", argv: ["config", "set", "project", g.project], describe: `project=${g.project}` });
  if (g?.region)
    steps.push({ tool: "gcloud", argv: ["config", "set", "run/region", g.region], describe: `run/region=${g.region}` });
  if (ctx.git?.email)
    steps.push({ tool: "git", argv: ["config", "user.email", ctx.git.email], local: true, describe: `git user.email=${ctx.git.email}` });
  return steps;
}

export interface ApplyResult {
  step: ContextStep;
  ok: boolean;
}

/** Execute the activation plan. Each step runs via execFile (no shell). */
export async function applyContext(
  ctx: ContextConfig,
  cwd: string = process.cwd(),
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  for (const step of planContext(ctx)) {
    let ok = false;
    try {
      await exec(step.tool, step.argv, { timeout: 8_000, cwd: step.local ? cwd : undefined });
      ok = true;
    } catch {
      ok = false;
    }
    results.push({ step, ok });
  }
  return results;
}

// ── kit context --prompt — a fast, read-only PS1 indicator ───────────────────

/** Extract `project = <value>` from a gcloud configuration INI. PURE. */
export function parseGcloudProject(ini: string): string | null {
  const m = ini.match(/^\s*project\s*=\s*(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * A compact indicator of the ACTIVE gcloud context for a shell prompt, read from
 * gcloud's config files (no subprocess, so it is cheap to call per prompt).
 * Returns "" if gcloud config cannot be read. Example: "[gcp:cbd-platform]".
 */
export function contextPrompt(): string {
  try {
    const dir = process.env.CLOUDSDK_CONFIG || join(homedir(), ".config", "gcloud");
    const active = readFileSync(join(dir, "active_config"), "utf8").trim();
    const ini = readFileSync(join(dir, "configurations", `config_${active}`), "utf8");
    const project = parseGcloudProject(ini);
    return project ? `[gcp:${project}]` : active ? `[gcp:${active}]` : "";
  } catch {
    return "";
  }
}
