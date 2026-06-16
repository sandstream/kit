/**
 * kit status — a deterministic "where you are + what to do next" view across kit.
 *
 * Pure facts + rule-based next steps (never LLM advice). Each signal is checked
 * against real local state: the config file, the vault declaration, the agent
 * managed block, the memory store, the installed hooks. Designed to grow: add a
 * StatusItem per subsystem (prescan drift, supply-chain, elevation, …).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { KIT_BLOCK_BEGIN } from "./agent-config.js";
import { checkGitignore } from "./check-gitignore.js";
import { openMemoryDb, getStats } from "./memory/db.js";
import { getClaudeSettingsPath } from "./memory/install.js";

// Dependency allowlist file (kept as a literal here, matching security-policy.ts
// + post-pull-audit.ts — the convention isn't exported).
const ALLOWLIST_FILE = ".kit-allowlist.json";

export interface StatusItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Rule-based next step when not ok (deterministic, no inference). */
  hint?: string;
}

function fileIncludes(path: string, needle: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false; // unreadable — treat as absent
  }
}

export async function gatherStatus(cwd: string = process.cwd()): Promise<StatusItem[]> {
  const items: StatusItem[] = [];

  const configPath = join(cwd, ".kit.toml");
  const hasConfig = existsSync(configPath);
  items.push({
    key: "config",
    label: ".kit.toml",
    ok: hasConfig,
    detail: hasConfig ? "present" : "missing",
    hint: hasConfig ? undefined : "run `kit init`",
  });

  if (hasConfig) {
    try {
      const cfg = await loadConfig(configPath);
      const hasVault = !!(
        cfg.secrets &&
        (cfg.secrets.store || (cfg.secrets.keys && Object.keys(cfg.secrets.keys).length > 0))
      );
      items.push({
        key: "vault",
        label: "secrets vault",
        ok: hasVault,
        detail: hasVault ? `store: ${cfg.secrets?.store ?? "keys"}` : "none configured",
        hint: hasVault ? undefined : "configure [secrets] + `kit secrets`",
      });
      const toolCount = cfg.tools ? Object.keys(cfg.tools).length : 0;
      items.push({
        key: "tools",
        label: "tools",
        ok: toolCount > 0,
        detail: `${toolCount} declared`,
        hint: toolCount > 0 ? undefined : "declare [tools] in .kit.toml",
      });
    } catch {
      // malformed config — skip the derived checks rather than crash
    }
  }

  // Secret hygiene — does .gitignore cover the sensitive paths kit cares about?
  const ignore = await checkGitignore(cwd);
  items.push({
    key: "gitignore",
    label: "gitignore hygiene",
    ok: ignore.missingPatterns.length === 0,
    detail:
      ignore.missingPatterns.length === 0
        ? "sensitive paths covered"
        : `${ignore.missingPatterns.length} sensitive path(s) unignored`,
    hint: ignore.missingPatterns.length === 0 ? undefined : "run `kit security check-gitignore --fix`",
  });

  // Supply chain — is there a dependency allowlist to enforce on install?
  const hasAllowlist = existsSync(join(cwd, ALLOWLIST_FILE));
  items.push({
    key: "dep-policy",
    label: "dependency policy",
    ok: hasAllowlist,
    detail: hasAllowlist ? "allowlist present" : "no allowlist",
    hint: hasAllowlist ? undefined : "run `kit security policy init`",
  });

  const wired = fileIncludes(join(cwd, "CLAUDE.md"), KIT_BLOCK_BEGIN);
  items.push({
    key: "agent-config",
    label: "agent wired",
    ok: wired,
    detail: wired ? "CLAUDE.md kit block present" : "not wired",
    hint: wired ? undefined : "run `kit agent-config`",
  });

  let messages = 0;
  try {
    const db = openMemoryDb();
    messages = getStats(db).messages;
    db.close();
  } catch {
    // memory store unavailable — reported as 0
  }
  items.push({
    key: "memory",
    label: "memory indexed",
    ok: messages > 0,
    detail: `${messages} messages`,
    hint: messages > 0 ? undefined : "run `kit memory index`",
  });

  const hooked = fileIncludes(getClaudeSettingsPath(), "kit memory hook");
  items.push({
    key: "memory-hooks",
    label: "memory hooks",
    ok: hooked,
    detail: hooked ? "installed" : "not installed",
    hint: hooked ? undefined : "run `kit memory install`",
  });

  return items;
}
