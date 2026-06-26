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
  gitlab?: { group: string | null; remote: string | null };
  bitbucket?: { workspace: string | null; remote: string | null };
  ssh?: { identity: string | null; fingerprint: string | null; host_alias: string | null };
  npm?: { registry: string | null };
  vercel?: { orgId: string | null; projectId: string | null };
  keycloak?: { realm: string | null };
  auth0?: { tenant: string | null };
  clerk?: { env: string | null };
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
  {
    tool: "gcloud",
    field: "account",
    declared: (d) => d.gcloud?.account,
    live: (l) => l.gcloud?.account ?? null,
  },
  {
    tool: "gcloud",
    field: "project",
    declared: (d) => d.gcloud?.project,
    live: (l) => l.gcloud?.project ?? null,
  },
  { tool: "git", field: "email", declared: (d) => d.git?.email, live: (l) => l.git?.email ?? null },
  {
    tool: "github",
    field: "org",
    declared: (d) => d.github?.org,
    live: (l) => l.github?.org ?? null,
  },
  {
    tool: "github",
    field: "remote",
    declared: (d) => d.github?.remote,
    live: (l) => l.github?.remote ?? null,
  },
  {
    tool: "gitlab",
    field: "group",
    declared: (d) => d.gitlab?.group,
    live: (l) => l.gitlab?.group ?? null,
  },
  {
    tool: "gitlab",
    field: "remote",
    declared: (d) => d.gitlab?.remote,
    live: (l) => l.gitlab?.remote ?? null,
  },
  {
    tool: "bitbucket",
    field: "workspace",
    declared: (d) => d.bitbucket?.workspace,
    live: (l) => l.bitbucket?.workspace ?? null,
  },
  {
    tool: "bitbucket",
    field: "remote",
    declared: (d) => d.bitbucket?.remote,
    live: (l) => l.bitbucket?.remote ?? null,
  },
  {
    tool: "ssh",
    field: "identity",
    declared: (d) => d.ssh?.identity,
    live: (l) => l.ssh?.identity ?? null,
  },
  {
    tool: "ssh",
    field: "fingerprint",
    declared: (d) => d.ssh?.fingerprint,
    live: (l) => l.ssh?.fingerprint ?? null,
  },
  {
    tool: "ssh",
    field: "host_alias",
    declared: (d) => d.ssh?.host_alias,
    live: (l) => l.ssh?.host_alias ?? null,
  },
  {
    tool: "npm",
    field: "registry",
    declared: (d) => d.npm?.registry,
    live: (l) => l.npm?.registry ?? null,
  },
  {
    tool: "vercel",
    field: "team(orgId)",
    declared: (d) => d.vercel?.team,
    live: (l) => l.vercel?.orgId ?? null,
  },
  {
    tool: "vercel",
    field: "project(projectId)",
    declared: (d) => d.vercel?.project,
    live: (l) => l.vercel?.projectId ?? null,
  },
  // App-service auth identity — "dev pointed at prod" guard.
  {
    tool: "keycloak",
    field: "realm",
    declared: (d) => d.keycloak?.realm,
    live: (l) => l.keycloak?.realm ?? null,
  },
  {
    tool: "auth0",
    field: "tenant",
    declared: (d) => d.auth0?.tenant,
    live: (l) => l.auth0?.tenant ?? null,
  },
  { tool: "clerk", field: "env", declared: (d) => d.clerk?.env, live: (l) => l.clerk?.env ?? null },
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
  emit("[context.gitlab]", [
    ["group", live.gitlab?.group, "from origin remote — authoritative"],
    ["remote", live.gitlab?.remote, ""],
  ]);
  emit("[context.bitbucket]", [
    ["workspace", live.bitbucket?.workspace, "from origin remote — authoritative"],
    ["remote", live.bitbucket?.remote, ""],
  ]);
  emit("[context.vercel]", [
    ["team", live.vercel?.orgId, "orgId from .vercel/project.json — authoritative"],
    ["project", live.vercel?.projectId, "projectId"],
  ]);
  emit("[context.gcloud]", [
    [
      "account",
      live.gcloud?.account,
      "⚠ currently-active gcloud — VERIFY it is right for THIS repo",
    ],
    ["project", live.gcloud?.project, "⚠ verify"],
  ]);
  emit("[context.npm]", [["registry", live.npm?.registry, "global npm registry"]]);
  return out.join("\n").trimEnd();
}

/**
 * Does a live snapshot carry account/project context worth locking at init?
 * git email + npm registry alone don't qualify (low contamination risk, noisy
 * to prompt about); the cross-account bugs this lock exists for live in the
 * gcloud / vercel / github bindings, so the brownfield `kit init` offer gates on
 * those. PURE so it's unit-testable.
 */
export function hasLockableContext(live: LiveContext): boolean {
  return Boolean(
    live.gcloud?.account ||
    live.vercel?.projectId ||
    live.github?.org ||
    live.gitlab?.group ||
    live.bitbucket?.workspace,
  );
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
export function parseGithubRemote(url: string | null): {
  org: string | null;
  remote: string | null;
} {
  if (!url) return { org: null, remote: null };
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return { org: null, remote: null };
  return { org: m[1], remote: `github.com/${m[1]}/${m[2]}` };
}

/** gitlab.com[:/]group(/subgroups)/repo(.git) -> { group (top-level), "gitlab.com/<path>" }. */
export function parseGitlabRemote(url: string | null): {
  group: string | null;
  remote: string | null;
} {
  if (!url) return { group: null, remote: null };
  const m = url.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
  if (!m) return { group: null, remote: null };
  const path = m[1].replace(/\/+$/, "");
  const group = path.split("/")[0] || null;
  return { group, remote: `gitlab.com/${path}` };
}

/** bitbucket.org[:/]workspace/repo(.git) -> { workspace, "bitbucket.org/workspace/repo" }. */
export function parseBitbucketRemote(url: string | null): {
  workspace: string | null;
  remote: string | null;
} {
  if (!url) return { workspace: null, remote: null };
  const m = url.match(/bitbucket\.org[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return { workspace: null, remote: null };
  return { workspace: m[1], remote: `bitbucket.org/${m[1]}/${m[2]}` };
}

/** The literal host token of a remote URL (the `Host` alias when one is used). */
export function parseRemoteHost(url: string | null): string | null {
  if (!url) return null;
  const ssh = url.match(/^(?:ssh:\/\/)?[^@]+@([^:/]+)/);
  if (ssh) return ssh[1];
  const https = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)/);
  if (https) return https[1];
  return null;
}

/** The `-i <path>` identity from a git `core.sshCommand`, if set. */
export function parseSshCommandIdentity(cmd: string | null): string | null {
  if (!cmd) return null;
  const m = cmd.match(/-i\s+("[^"]+"|'[^']+'|\S+)/);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

/** First configured IdentityFile from `ssh -G <host>` output (configured precede defaults). */
export function parseSshConfigIdentity(sshGOutput: string | null): string | null {
  if (!sshGOutput) return null;
  for (const line of sshGOutput.split("\n")) {
    const m = line.match(/^identityfile\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

/** The SHA256 fingerprint from `ssh-keygen -lf <file>` output. */
export function parseKeygenFingerprint(out: string | null): string | null {
  if (!out) return null;
  const m = out.match(/SHA256:[A-Za-z0-9+/=]+/);
  return m ? m[0] : null;
}

/** Expand a leading `~` to the home dir, for comparing declared vs live paths. */
function expandHome(p: string | null): string | null {
  if (!p) return null;
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Read the live context from each tool. Every read fails soft to null. */
/** Clerk publishable keys are `pk_live_…` / `pk_test_…`; the env segment is the
 * "dev pointed at prod" signal. Returns "live" | "test" | null. */
export function clerkEnvFromKey(pk: string | null): string | null {
  if (!pk) return null;
  const m = /^pk_(live|test)_/.exec(pk.trim());
  return m ? m[1] : null;
}

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
  // The single origin remote parsed per host; only the matching host yields values.
  live.github = parseGithubRemote(remote);
  live.gitlab = parseGitlabRemote(remote);
  live.bitbucket = parseBitbucketRemote(remote);

  // SSH identity this repo would actually push with: a per-repo core.sshCommand
  // override wins; otherwise resolve the remote host through `ssh -G`. The host
  // token (a `Host` alias when one is used) is the third comparable signal.
  const host = parseRemoteHost(remote);
  const sshCommand = await run("git", ["config", "--get", "core.sshCommand"]);
  let identity = parseSshCommandIdentity(sshCommand);
  if (!identity && host) identity = parseSshConfigIdentity(await run("ssh", ["-G", host]));
  identity = expandHome(identity);
  const fingerprint = identity
    ? parseKeygenFingerprint(await run("ssh-keygen", ["-lf", identity]))
    : null;
  live.ssh = { identity, fingerprint, host_alias: host };

  const registry = await run("npm", ["config", "get", "registry"]);
  live.npm = { registry: registry ? registry.replace(/\/+$/, "") : null };

  try {
    const raw = await readFile(resolve(cwd, ".vercel", "project.json"), "utf8");
    const j = JSON.parse(raw) as { orgId?: string; projectId?: string };
    live.vercel = { orgId: j.orgId ?? null, projectId: j.projectId ?? null };
  } catch {
    live.vercel = { orgId: null, projectId: null };
  }

  // App-service auth identity from the app's env — the "live" realm/tenant the app
  // would actually authenticate against. Only set when the env names it (so an
  // undeclared service stays unchecked rather than reporting a spurious unknown).
  const kcRealm = process.env.KEYCLOAK_REALM ?? null;
  if (kcRealm) live.keycloak = { realm: kcRealm };
  const auth0Tenant = process.env.AUTH0_DOMAIN ?? process.env.AUTH0_TENANT ?? null;
  if (auth0Tenant) live.auth0 = { tenant: auth0Tenant };
  const clerkEnv = clerkEnvFromKey(
    process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
  );
  if (clerkEnv) live.clerk = { env: clerkEnv };

  return live;
}

/** Verify the declared context against live tool state. Empty if nothing declared. */
export async function checkContext(
  ctx: ContextConfig | undefined,
  cwd: string = process.cwd(),
): Promise<ContextFinding[]> {
  if (!ctx) return [];
  // Normalize declared values the same way the live reads are normalized:
  // npm registry trailing slash, and ssh identity `~` expansion (compared as paths).
  let declared: ContextConfig = ctx;
  if (ctx.npm?.registry) {
    declared = {
      ...declared,
      npm: { ...declared.npm, registry: ctx.npm.registry.replace(/\/+$/, "") },
    };
  }
  if (declared.ssh?.identity) {
    declared = {
      ...declared,
      ssh: {
        ...declared.ssh,
        identity: expandHome(declared.ssh.identity) ?? declared.ssh.identity,
      },
    };
  }
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
    steps.push({
      tool: "gcloud",
      argv: ["config", "configurations", "activate", g.config],
      describe: `activate config ${g.config}`,
    });
  if (g?.account)
    steps.push({
      tool: "gcloud",
      argv: ["config", "set", "account", g.account],
      describe: `account=${g.account}`,
    });
  if (g?.project)
    steps.push({
      tool: "gcloud",
      argv: ["config", "set", "project", g.project],
      describe: `project=${g.project}`,
    });
  if (g?.region)
    steps.push({
      tool: "gcloud",
      argv: ["config", "set", "run/region", g.region],
      describe: `run/region=${g.region}`,
    });
  if (ctx.git?.email)
    steps.push({
      tool: "git",
      argv: ["config", "user.email", ctx.git.email],
      local: true,
      describe: `git user.email=${ctx.git.email}`,
    });
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
  // Read-only mode: activating a context mutates gcloud config / repo git
  // identity. Refuse + audit; apply nothing (no-op, no steps run).
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    await refuseWrite("context-use", { step_count: planContext(ctx).length });
    return [];
  }

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
