import { resolve } from "node:path";
import type { kitConfig, HooksConfig } from "./config.js";
import { installMemoryHooks, installCodexMemoryHooks } from "./memory/install.js";
import { installHooks, type HookInstallResult } from "./hooks.js";

export interface RecommendedResult {
  memory: {
    claude: { added: string[]; alreadyPresent: string[]; resolved: boolean };
    codex: { added: string[]; alreadyPresent: string[]; resolved: boolean };
  };
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
 *   - cross-harness memory capture (Claude Code + Codex lifecycle hooks)
 *   - a pre-commit gate: secret-scan + triage gates for newly-added deps and staged skills +
 *     the ADR gate (accepted ADRs' kit-enforce rules; a no-op when there are no ADRs)
 *   - a pre-push context-check gate (only when `[context]` is declared)
 *
 * The triage gates (`kit triage check-deps` / `check-skills`) were always meant to run at
 * commit time — they're the fail-closed chokepoint that refuses staged deps/skills lacking a
 * recent triage. Wiring them into the recommended pre-commit turns the documented gates into
 * enforced ones. Both are cheap no-ops when nothing relevant is staged.
 *
 * Each piece is idempotent and uses the already-hardened installers
 * (absolute-path memory hooks; hooksPath-aware, no-clobber git hooks). It
 * touches GLOBAL `~/.claude` / `~/.codex` (memory hooks) and the repo's git hooks, so the
 * caller must surface that to the user first.
 */
/**
 * The recommended posture as a REPORT — what a repo would gain, with nothing written.
 *
 * `applyRecommendedHardening` knew this and was reachable only from `kit setup`, so the only way
 * to ask "what would I get?" was to let it write to `~/.claude`, `~/.codex` and the repo's git
 * hooks (#511). A repo that already exists needs the read-only half: a long-lived `.kit.toml`
 * silently keeps whatever posture it was set up with, and nothing said which sections kit has
 * learned since.
 *
 * Each row states what it BUYS, not just that it is missing — a checklist of absent features is
 * how a report gets ignored. Pure given (config, probes), so the tests do not need a machine in
 * any particular state.
 */
export interface RecommendationRow {
  key: string;
  /** Present already, or worth adopting. */
  adopted: boolean;
  label: string;
  /** One line: what declaring/installing this buys. */
  buys: string;
  /** The command that adopts it, when it is not adopted. */
  how?: string;
}

export interface RecommendProbes {
  /** Memory capture hooks wired in the agent lifecycle configs. */
  memoryHooks: boolean;
  /** kit-managed git hooks present in the resolved hooks dir. */
  gitHooks: string[];
}

export function recommendPosture(config: kitConfig, probes: RecommendProbes): RecommendationRow[] {
  const rows: RecommendationRow[] = [];

  rows.push({
    key: "memory-hooks",
    adopted: probes.memoryHooks,
    label: "cross-harness memory capture",
    buys: "transcripts from every agent land in one local store, so a later session can recall what was decided instead of re-deriving it",
    how: probes.memoryHooks ? undefined : "kit memory install",
  });

  rows.push({
    key: "secret-scan",
    adopted: probes.gitHooks.includes("secret-scan"),
    label: "pre-commit secret scan",
    buys: "a staged credential is refused before it becomes git history, which is immutable",
    how: probes.gitHooks.includes("secret-scan") ? undefined : "kit hooks add secret-scan",
  });

  rows.push({
    key: "post-pull-audit",
    adopted: probes.gitHooks.includes("post-pull-audit"),
    label: "post-merge audit",
    buys: "after a pull, new dependencies, dropped gitignore rules and introduced secrets are surfaced rather than inherited silently",
    how: probes.gitHooks.includes("post-pull-audit") ? undefined : "kit hooks add post-pull-audit",
  });

  const hasContext = config.context !== undefined;
  rows.push({
    key: "context",
    adopted: hasContext,
    label: "[context] CLI lock",
    buys: "each CLI is pinned to the account + project this repo must use, so a tool answering as the wrong identity is a red row instead of a filtered result set that looks complete",
    how: hasContext ? undefined : "kit context check  (prints a ready-to-paste block)",
  });

  rows.push({
    key: "context-check-hook",
    // Only meaningful once [context] exists — the gate has nothing to compare against otherwise,
    // which is why `kit hooks add context-check` now refuses without it.
    adopted: probes.gitHooks.includes("context-check"),
    label: "pre-push context check",
    buys: "a push to the wrong org/project is blocked before it leaves the machine",
    how: hasContext
      ? probes.gitHooks.includes("context-check")
        ? undefined
        : "kit hooks add context-check"
      : "declare [context] first — the gate has nothing to compare against without it",
  });

  rows.push({
    key: "policy-agent-writes",
    adopted: config.policy?.agent_writes !== undefined,
    label: "[policy.agent_writes]",
    buys: "vendor writes an agent may perform are declared and narrowed at kit's choke points and inside the plugins; an empty list is a lock, not a wildcard",
    how:
      config.policy?.agent_writes !== undefined
        ? undefined
        : "add [policy.agent_writes] to .kit.toml (see docs/POLICY.md)",
  });

  rows.push({
    key: "deploy-env",
    adopted: config.deploy !== undefined,
    label: "[deploy] env key names",
    buys: "`kit check --category deploy` diffs the env key NAMES your platform has against the ones this repo declares — never reading a value",
    how: config.deploy !== undefined ? undefined : "add [deploy] to .kit.toml",
  });

  rows.push({
    key: "audit-anchor",
    adopted: config.governance?.audit?.require_anchor === true,
    label: "[governance.audit] require_anchor",
    buys: "an unanchored or rewritten audit log fails the gate instead of reading as verified — tamper-evidence you can prove rather than assume",
    how:
      config.governance?.audit?.require_anchor === true
        ? undefined
        : "set [governance.audit] require_anchor = true",
  });

  return rows;
}

export async function applyRecommendedHardening(
  config: kitConfig,
  gitDir = ".git",
): Promise<RecommendedResult> {
  const memory = {
    claude: installMemoryHooks(),
    codex: installCodexMemoryHooks(),
  };

  const kit = kitInvocation();
  const hookConfig: HooksConfig = {
    "pre-commit": [
      `${kit} security scan-staged`,
      `${kit} triage check-deps`,
      `${kit} triage check-skills`,
      `${kit} adr check`,
    ],
  };
  // The context-check gate only makes sense once a context is declared.
  if (config.context) {
    hookConfig["pre-push"] = [`${kit} context check`];
  }
  const hooks = await installHooks(hookConfig, gitDir);

  return { memory, hooks };
}
