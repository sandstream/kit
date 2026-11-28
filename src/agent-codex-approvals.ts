/**
 * Codex with its approvals or sandbox turned off in saved config, the counterpart of Claude Code's
 * `permissions.defaultMode: "bypassPermissions"`, which `runAgentTrifecta` reports as "write access
 * without confirmation: main session". A Codex config with `approval_policy = "never"` and
 * `sandbox_mode = "danger-full-access"` gave no row at all.
 *
 * Keys, from developers.openai.com/codex/config-reference (read 2026-11-28):
 *   - `approval_policy`: `on-request | never | { granular = {...} }`; `never` runs commands
 *     without pausing for approval. A granular table auto-rejects prompts, so it is not flagged.
 *   - `sandbox_mode`: `read-only | workspace-write | danger-full-access`.
 *   - `default_permissions`: built-ins `:read-only`, `:workspace`, `:danger-full-access`.
 * Layers, from developers.openai.com/codex/config-advanced:
 *   - `$CODEX_HOME/config.toml` (default `~/.codex`), and `--profile <name>` overlays
 *     `$CODEX_HOME/<name>.config.toml`. Codex before 0.134.0 read `[profiles.<name>]` tables in
 *     `config.toml` instead; those tables are still reported, since an older Codex obeys them.
 *   - project `.codex/config.toml`, loaded once the project is trusted. Codex ignores `profile`
 *     and `profiles` there, so profile tables in a project file are not reported.
 *
 * Read-only and fail-open per file: a file that is missing or does not parse gives no row.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { SecurityCheckResult } from "./check-security.js";
import { codexHome } from "./agent-audit-user.js";

type Table = Record<string, unknown>;

/** What one config layer turns off, after laying it over `base`. Pure. */
export function codexApprovalsOff(
  layer: Table,
  base: Table = {},
): { approvals: boolean; sandbox: boolean; keys: string[] } {
  const keys: string[] = [];
  if (layer.approval_policy === "never") keys.push('approval_policy = "never"');
  if (layer.sandbox_mode === "danger-full-access") keys.push('sandbox_mode = "danger-full-access"');
  if (layer.default_permissions === ":danger-full-access") {
    keys.push('default_permissions = ":danger-full-access"');
  }
  const merged = { ...base, ...layer };
  return {
    approvals: merged.approval_policy === "never",
    sandbox:
      merged.sandbox_mode === "danger-full-access" ||
      merged.default_permissions === ":danger-full-access",
    keys,
  };
}

function readToml(path: string): Table | null {
  if (!existsSync(path)) return null;
  try {
    return parseToml(readFileSync(path, "utf8")) as Table;
  } catch {
    return null;
  }
}

function asTable(v: unknown): Table {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Table) : {};
}

/** The row for one layer, or null when the layer itself turns nothing off. */
function layerRow(where: string, layer: Table, base: Table): SecurityCheckResult | null {
  const off = codexApprovalsOff(layer, base);
  if (off.keys.length === 0) return null;
  const set = off.keys.join(" and ");
  if (off.approvals && off.sandbox) {
    return {
      category: "exposure",
      name: `write access without confirmation: Codex ${where}`,
      status: "warn",
      severity: "medium",
      detail: `${set}: Codex runs every command without a prompt and outside its sandbox, like Claude Code's bypassPermissions`,
      suggestion:
        'set approval_policy = "on-request" and sandbox_mode = "workspace-write"; run unattended only where the person chose it',
    };
  }
  return {
    category: "exposure",
    name: `${off.approvals ? "approvals off" : "sandbox off"}: Codex ${where}`,
    status: "warn",
    severity: "low",
    detail: off.approvals
      ? `${set}: Codex runs commands without a prompt; only its sandbox limits what they reach`
      : `${set}: commands Codex runs are not sandboxed; only its approval prompts stand in the way`,
    suggestion: off.approvals
      ? 'set approval_policy = "on-request", or keep sandbox_mode = "workspace-write" or stricter'
      : 'set sandbox_mode = "workspace-write" and keep approval_policy = "on-request"',
  };
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

/** Profile files in the Codex home: `<name>.config.toml`, names of letters, digits, `-` and `_`. */
function profileFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /^[A-Za-z0-9_-]+\.config\.toml$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

/** Rows for Codex config layers under `root` and the Codex home that turn approvals or the sandbox off. */
export function runCodexApprovals(
  root: string,
  home: string,
  env: Record<string, unknown> = {},
): SecurityCheckResult[] {
  const codex = codexHome(home, env);
  const user = readToml(join(codex.dir, "config.toml")) ?? {};
  const rows: (SecurityCheckResult | null)[] = [layerRow(`${codex.shown}/config.toml`, user, {})];
  for (const [name, table] of Object.entries(asTable(user.profiles))) {
    rows.push(layerRow(`${codex.shown}/config.toml [profiles.${name}]`, asTable(table), user));
  }
  for (const file of profileFiles(codex.dir)) {
    const layer = readToml(join(codex.dir, file));
    const name = file.slice(0, -".config.toml".length);
    if (layer) rows.push(layerRow(`${codex.shown}/${file} (--profile ${name})`, layer, user));
  }
  // Run from the home directory, the project file is the user file: report it once.
  const project = sameDir(join(root, ".codex"), codex.dir)
    ? null
    : readToml(join(root, ".codex", "config.toml"));
  if (project) rows.push(layerRow(".codex/config.toml", project, user));
  return rows.filter((r): r is SecurityCheckResult => r !== null);
}
