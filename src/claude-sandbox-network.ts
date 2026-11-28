/**
 * The `Claude Code sandbox network` row: Claude Code's sandbox is on, but its network allowlist is
 * not strict, so a sandboxed command can still reach hosts outside `allowedDomains`.
 *
 * `kit agent-config` turns on `sandbox.enabled` in the project `.claude/settings.json`. With that
 * alone, Claude Code decides a host outside the allowlist by permission mode, and "In
 * `bypassPermissions` mode, hosts outside your allowed domains are allowed unless" `strictAllowlist`
 * or `allowManagedDomainsOnly` is on (kit-research `agent-vm-yolo-herdr-paseo-vs-kit`).
 *
 * Settings, from https://code.claude.com/docs/en/settings-reference and /sandboxing (read
 * 2026-11-28):
 *   - `sandbox.enabled`: any settings file; the highest-precedence file that sets it wins
 *     (managed > `.claude/settings.local.json` > `.claude/settings.json` > user).
 *   - `sandbox.network.strictAllowlist`: "Deny sandboxed commands access to hosts outside the
 *     allowlist instead of prompting for approval." Scope "User or managed. A repository can't turn
 *     it on or off." (`--settings` too, which kit cannot see.) Requires Claude Code v2.1.219.
 *   - `sandbox.network.allowManagedDomainsOnly`: managed only; it also blocks a non-allowed domain.
 *   - `permissions.defaultMode: "bypassPermissions"` allows such a host without a prompt.
 *
 * A repository file that sets `strictAllowlist` is ignored here, as Claude Code ignores it. A file
 * that does not parse counts as setting nothing, so it never makes the allowlist look strict.
 * Server-managed and MDM settings, and a custom proxy (`httpProxyPort`/`socksProxyPort`, which
 * takes over filtering), are not read. The sandbox does not run on native Windows, so no row there.
 * Read-only; never runs anything a settings file names.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeManagedDir } from "./agent-rule-sources.js";
import type { SecurityCheckResult } from "./check-security.js";

const NAME = "Claude Code sandbox network";
type Table = Record<string, unknown>;
type Scope = "user" | "project" | "local" | "managed";
interface Layer {
  scope: Scope;
  file: string;
  value: Table;
}

/** Where to look; each field defaults to this process (tests inject them). */
interface SandboxNetworkOpts {
  home?: string;
  env?: Record<string, unknown>;
  platform?: NodeJS.Platform;
  /** Managed settings directories; the OS default when absent. */
  managedDirs?: string[];
}

interface Ctx {
  root: string;
  home: string;
  env: Record<string, unknown>;
  platform: NodeJS.Platform;
  managedDirs?: string[];
}

function asTable(v: unknown): Table {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Table) : {};
}

function readLayer(scope: Scope, abs: string, file: string): Layer | null {
  try {
    return { scope, file, value: asTable(JSON.parse(readFileSync(abs, "utf-8"))) };
  } catch {
    return null;
  }
}

function managedFiles(dir: string): string[] {
  let extra: string[] = [];
  try {
    extra = readdirSync(join(dir, "managed-settings.d"))
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .sort()
      .map((n) => join(dir, "managed-settings.d", n));
  } catch {
    /* no drop-in directory */
  }
  return [join(dir, "managed-settings.json"), ...extra];
}

/** The settings files Claude Code reads, lowest precedence first. */
function layers(ctx: Ctx): Layer[] {
  const custom = typeof ctx.env.CLAUDE_CONFIG_DIR === "string" && ctx.env.CLAUDE_CONFIG_DIR.trim();
  const user = custom
    ? readLayer("user", join(custom, "settings.json"), "$CLAUDE_CONFIG_DIR/settings.json")
    : readLayer("user", join(ctx.home, ".claude", "settings.json"), "~/.claude/settings.json");
  const out = [
    user,
    readLayer("project", join(ctx.root, ".claude", "settings.json"), ".claude/settings.json"),
    readLayer(
      "local",
      join(ctx.root, ".claude", "settings.local.json"),
      ".claude/settings.local.json",
    ),
  ];
  for (const dir of ctx.managedDirs ?? [claudeManagedDir(ctx.platform, ctx.env)]) {
    for (const f of managedFiles(dir)) out.push(readLayer("managed", f, f));
  }
  return out.filter((l): l is Layer => l !== null);
}

const sandboxOf = (l: Layer): Table => asTable(l.value.sandbox);
const networkOf = (l: Layer): Table => asTable(sandboxOf(l).network);

/** The file whose `sandbox.enabled` wins, when it is `true`. */
function enabledBy(all: Layer[]): Layer | null {
  let winner: Layer | null = null;
  for (const l of all) if (typeof sandboxOf(l).enabled === "boolean") winner = l;
  return winner && sandboxOf(winner).enabled === true ? winner : null;
}

/** The honored file that makes the allowlist strict, and the key it sets. */
function strictBy(all: Layer[]): { layer: Layer; key: string } | null {
  for (const l of all) {
    if (l.scope === "managed" && networkOf(l).allowManagedDomainsOnly === true) {
      return { layer: l, key: "sandbox.network.allowManagedDomainsOnly" };
    }
    if ((l.scope === "user" || l.scope === "managed") && networkOf(l).strictAllowlist === true) {
      return { layer: l, key: "sandbox.network.strictAllowlist" };
    }
  }
  return null;
}

function bypassBy(all: Layer[]): Layer | null {
  const hit = all.filter((l) => asTable(l.value.permissions).defaultMode === "bypassPermissions");
  return hit.length > 0 ? hit[hit.length - 1] : null;
}

const SUGGESTION =
  'add "sandbox": { "network": { "strictAllowlist": true } } to ~/.claude/settings.json or managed ' +
  "settings (Claude Code v2.1.219+); a repository .claude/settings.json cannot set it. List the " +
  "hosts commands need in sandbox.network.allowedDomains";

/** The row, or `skip` when the sandbox is off, not configured, or cannot run (native Windows). */
export function claudeSandboxNetworkRow(
  root: string,
  opts: SandboxNetworkOpts = {},
): SecurityCheckResult {
  const ctx: Ctx = {
    root,
    home: opts.home ?? homedir(),
    env: opts.env ?? process.env,
    platform: opts.platform ?? process.platform,
    managedDirs: opts.managedDirs,
  };
  const skip = (detail: string): SecurityCheckResult => ({
    category: "exposure",
    name: NAME,
    status: "skip",
    detail,
  });
  if (ctx.platform === "win32") return skip("Claude Code's sandbox does not run on native Windows");
  const all = layers(ctx);
  const enabled = enabledBy(all);
  if (!enabled) return skip("sandbox.enabled is not true in any Claude Code settings file");
  const strict = strictBy(all);
  if (strict) {
    const detail = `sandbox on (${enabled.file}); ${strict.key} is true in ${strict.layer.file}: sandboxed commands cannot reach hosts outside the allowlist`;
    return { category: "exposure", name: NAME, status: "pass", detail };
  }
  const bypass = bypassBy(all);
  const lead = `sandbox.enabled is true in ${enabled.file}, but sandbox.network.strictAllowlist is not on in user or managed settings`;
  return {
    category: "exposure",
    name: NAME,
    status: "warn",
    severity: bypass ? "medium" : "low",
    detail: bypass
      ? `${lead}; with permissions.defaultMode "bypassPermissions" (${bypass.file}) sandboxed commands reach hosts outside allowedDomains without a prompt`
      : `${lead}: a host outside allowedDomains is decided by permission mode (asked by default, allowed in bypassPermissions)`,
    suggestion: SUGGESTION,
  };
}

/**
 * The `kit agent-config` line once the sandbox is on (`sandbox` is its `SandboxState`), or null.
 * Report only: `strictAllowlist` lives in user or managed settings, which a project run never writes.
 */
export function agentConfigSandboxLine(
  sandbox: string,
  root: string = process.cwd(),
  opts: SandboxNetworkOpts = {},
): string | null {
  if (sandbox !== "enabled" && sandbox !== "already-enabled") return null;
  const row = claudeSandboxNetworkRow(root, opts);
  if (row.status === "pass") return `= sandbox network strict: ${row.detail}`;
  if (row.status !== "warn") return null;
  return `! sandbox network not strict: hosts outside allowedDomains are reachable. ${row.suggestion}`;
}
