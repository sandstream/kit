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
import { loadConfig, type HooksConfig } from "./config.js";
import { checkHooks, hookCheckStatus } from "./check-hooks.js";
import { KIT_BLOCK_BEGIN } from "./agent-config.js";
import { checkGitignore } from "./check-gitignore.js";
import { openMemoryDb, getStats } from "./memory/db.js";
import { allMemoryHooksLiveness } from "./memory/install.js";

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

async function gitignoreStatus(cwd: string): Promise<StatusItem> {
  const item = { key: "gitignore", label: "gitignore hygiene" };
  try {
    const ignore = await checkGitignore(cwd);
    return {
      ...item,
      ok: ignore.missingPatterns.length === 0,
      detail:
        ignore.missingPatterns.length === 0
          ? "sensitive paths covered"
          : `${ignore.missingPatterns.length} sensitive path(s) unprotected`,
      hint:
        ignore.trackedFiles.length > 0
          ? "review already tracked sensitive files; ignore rules cannot untrack them"
          : ignore.missingPatterns.length === 0
            ? undefined
            : "run `kit security check-gitignore --fix`",
    };
  } catch (error) {
    return {
      ...item,
      ok: false,
      detail:
        error instanceof Error ? error.message : "Git ignore protection could not be verified",
      hint: "ensure Git is available and run inside a Git working tree",
    };
  }
}

const hint = (ok: boolean, text: string): string | undefined => (ok ? undefined : text);

function configItem(hasConfig: boolean): StatusItem {
  return {
    key: "config",
    label: ".kit.toml",
    ok: hasConfig,
    detail: hasConfig ? "present" : "missing",
    hint: hint(hasConfig, "run `kit init`"),
  };
}

/** The vault and tools rows, plus the hooks the config declares. A malformed config adds nothing. */
async function configDerived(
  configPath: string,
): Promise<{ items: StatusItem[]; hooks?: HooksConfig }> {
  try {
    const cfg = await loadConfig(configPath);
    const hasVault = !!(
      cfg.secrets &&
      (cfg.secrets.store || (cfg.secrets.keys && Object.keys(cfg.secrets.keys).length > 0))
    );
    const toolCount = cfg.tools ? Object.keys(cfg.tools).length : 0;
    return {
      hooks: cfg.hooks,
      items: [
        {
          key: "vault",
          label: "secrets vault",
          ok: hasVault,
          detail: hasVault ? `store: ${cfg.secrets?.store ?? "keys"}` : "none configured",
          hint: hint(hasVault, "configure [secrets] + `kit secrets`"),
        },
        {
          key: "tools",
          label: "tools",
          ok: toolCount > 0,
          detail: `${toolCount} declared`,
          hint: hint(toolCount > 0, "declare [tools] in .kit.toml"),
        },
      ],
    };
  } catch {
    return { items: [] }; // malformed config: skip the derived checks rather than crash
  }
}

// Schema currency. `kit config migrate --check` has answered this since versioning landed, and
// nothing called it, so `✓ .kit.toml present` was the only thing the checklist said about the
// config. "present" is not "current" (#511). Behind means not ok, and nothing is written.
async function configSchemaItems(cwd: string): Promise<StatusItem[]> {
  try {
    const { planConfigMigration } = await import("./config-migrate.js");
    const plan = planConfigMigration(cwd);
    if (plan === null) return [];
    return [
      {
        key: "config-schema",
        label: "config schema",
        ok: plan.current,
        detail: plan.current
          ? `v${plan.toVersion}, current`
          : `v${plan.fromVersion}, current is v${plan.toVersion}`,
        hint: hint(plan.current, "run `kit config migrate`"),
      },
    ];
  } catch {
    return []; // an unreadable or malformed config is already reported by the rows above
  }
}

function depPolicyItem(cwd: string): StatusItem {
  const has = existsSync(join(cwd, ALLOWLIST_FILE));
  return {
    key: "dep-policy",
    label: "dependency policy",
    ok: has,
    detail: has ? "allowlist present" : "no allowlist",
    hint: hint(has, "run `kit security policy init`"),
  };
}

function agentConfigItem(cwd: string): StatusItem {
  const wired = fileIncludes(join(cwd, "CLAUDE.md"), KIT_BLOCK_BEGIN);
  return {
    key: "agent-config",
    label: "agent wired",
    ok: wired,
    detail: wired ? "CLAUDE.md kit block present" : "not wired",
    hint: hint(wired, "run `kit agent-config`"),
  };
}

function memoryItem(): StatusItem {
  let messages = 0;
  try {
    const db = openMemoryDb();
    messages = getStats(db).messages;
    db.close();
  } catch {
    // memory store unavailable: reported as 0
  }
  return {
    key: "memory",
    label: "memory indexed",
    ok: messages > 0,
    detail: `${messages} messages`,
    hint: hint(messages > 0, "run `kit memory index`"),
  };
}

function memoryHooksItem(): StatusItem {
  const liveness = allMemoryHooksLiveness();
  const hooked = liveness.everInstalled && liveness.missing.length === 0;
  const detail = !liveness.everInstalled
    ? "not installed"
    : liveness.missing.length > 0
      ? `missing: ${liveness.missing.join(", ")}`
      : `${liveness.present.length} wired`;
  return {
    key: "memory-hooks",
    label: "memory hooks",
    ok: hooked,
    detail,
    hint: hint(hooked, "run `kit memory install`"),
  };
}

async function gitHooksItem(cwd: string, configured: HooksConfig | undefined): Promise<StatusItem> {
  const checks = configured ? await checkHooks(configured, ".git", cwd) : [];
  const failing = checks.filter((check) => hookCheckStatus(check) === "fail");
  const wired = checks.length > 0 && failing.length === 0;
  const detail = wired
    ? `${checks.length} wired`
    : failing.length > 0
      ? `missing or outdated: ${failing.map((check) => check.hookName).join(", ")}`
      : "not configured";
  return {
    key: "git-hooks",
    label: "git hooks",
    ok: wired,
    detail,
    hint: hint(wired, "run `kit hooks check` and `kit hooks install`"),
  };
}

export async function gatherStatus(cwd: string = process.cwd()): Promise<StatusItem[]> {
  const configPath = join(cwd, ".kit.toml");
  const hasConfig = existsSync(configPath);
  const derived = hasConfig ? await configDerived(configPath) : { items: [] };
  return [
    configItem(hasConfig),
    ...derived.items,
    await gitignoreStatus(cwd), // does .gitignore cover the sensitive paths kit cares about?
    ...(await configSchemaItems(cwd)),
    depPolicyItem(cwd),
    agentConfigItem(cwd),
    memoryItem(),
    memoryHooksItem(),
    await gitHooksItem(cwd, derived.hooks),
  ];
}
