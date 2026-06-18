import { resolve } from "node:path";
import type { kitConfig, HooksConfig } from "./config.js";
import { installMemoryHooks } from "./memory/install.js";
import { installHooks, type HookInstallResult } from "./hooks.js";

export interface RecommendedResult {
  memory: { added: string[]; alreadyPresent: string[]; resolved: boolean };
  hooks: HookInstallResult[];
}

/**
 * Absolute self-invocation of kit for embedding in a generated git hook —
 * same reasoning as the memory-hook installer: git hooks may run in a shell
 * whose PATH lacks the npm global bin, so a bare `kit` can fail. Resolved from
 * the running process (`node <cli.js>`); falls back to bare `kit`.
 */
function kitInvocation(): string {
  const entry = process.argv[1];
  return entry ? `${process.execPath} ${resolve(entry)}` : "kit";
}

/**
 * The opinionated "recommended" hardening layered on top of `kit setup`:
 *   - cross-harness memory capture (the Claude Code hooks)
 *   - a pre-commit secret-scan gate
 *   - a pre-push context-check gate (only when `[context]` is declared)
 *
 * Each piece is idempotent and uses the already-hardened installers
 * (absolute-path memory hooks; hooksPath-aware, no-clobber git hooks). It
 * touches GLOBAL `~/.claude` (memory hooks) and the repo's git hooks, so the
 * caller must surface that to the user first.
 */
export async function applyRecommendedHardening(
  config: kitConfig,
  gitDir = ".git",
): Promise<RecommendedResult> {
  const memory = installMemoryHooks();

  const kit = kitInvocation();
  const hookConfig: HooksConfig = { "pre-commit": [`${kit} security scan-staged`] };
  // The context-check gate only makes sense once a context is declared.
  if (config.context) {
    hookConfig["pre-push"] = [`${kit} context check`];
  }
  const hooks = await installHooks(hookConfig, gitDir);

  return { memory, hooks };
}
