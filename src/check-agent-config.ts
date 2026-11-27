/**
 * `kit check`'s view of the agent configuration: the project and user-level agent audit.
 *
 * `kit check` never ran it, so a `SessionStart` hook running `curl … | sh` in
 * `.claude/settings.json` produced no row in `kit check --category security`, while
 * `kit agent-audit` failed on the same project (kit-research
 * `supply-chain-2026-fundamentals-vs-kit`). The worms of 2026 persisted exactly there.
 *
 * The same held for a redirected model endpoint and a code-loading variable in a settings `env`
 * block: `kit agent-audit` warned, `kit check` printed "agent-audit: no issues" (kit-research
 * `dragos-canary-prompts-vs-kit`). Both rows are part of this view now.
 *
 * The agent rule ledger's findings (new allow rules, removed deny or ask rules, unparsed rules)
 * are here too: removing kit's own deny rules changed no row of `kit check` (kit-research
 * `prismor-always-allowed-rules-vs-kit`).
 *
 * `instruction-file secrets` sits next to agent-audit: the files every harness loads as
 * instructions (AGENTS.md, CLAUDE.md, .cursorrules, GEMINI.md, Copilot's), read for keys. The
 * instruction-constraint rows read the same files for rule lines that name missing code or that
 * the working tree dropped since HEAD.
 */
import { homedir } from "node:os";
import type { SecurityCheckResult } from "./check-security.js";

export async function checkAgentConfig(
  root: string,
  home = homedir(),
  env: Record<string, unknown> = process.env,
): Promise<SecurityCheckResult[]> {
  const { runAgentAudit } = await import("./agent-audit.js");
  const { runUserAgentAudit } = await import("./agent-audit-user.js");
  const { checkMcpLoopbackToken } = await import("./check-mcp-loopback-token.js");
  const { checkPreTrusted } = await import("./check-pretrusted.js");
  const { checkWorktreeInclude } = await import("./check-worktreeinclude.js");
  const { checkGitEmail } = await import("./check-git-email.js");
  const { checkInstructionSecrets } = await import("./check-instruction-secrets.js");
  const { checkInstructionConstraints } = await import("./check-instruction-constraints.js");
  const { checkPlaintextCredentials } = await import("./check-plaintext-credentials.js");
  const { userSurfaceDriftRows } = await import("./user-surface-drift.js");
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  const { runAgentPreload } = await import("./agent-preload.js");
  const { runAgentEndpoint } = await import("./agent-endpoint.js");
  const { runRuleLedger } = await import("./agent-rule-ledger.js");
  const { checkCodexHookTrust } = await import("./codex-hook-trust.js");
  const { checkAiderCommitVerify } = await import("./check-aider-commit-verify.js");
  return [
    ...runAgentAudit(root),
    ...checkInstructionSecrets(root),
    ...checkInstructionConstraints(root),
    ...runUserAgentAudit(root, home, env),
    ...userSurfaceDriftRows(home, env, !isReadOnlyMode()),
    ...checkMcpLoopbackToken(root),
    ...checkPreTrusted(root, home, env),
    ...checkWorktreeInclude(root),
    ...(await checkGitEmail(root)),
    ...checkPlaintextCredentials(home),
    ...runAgentPreload(root, home, env),
    ...runAgentEndpoint(root, home, env),
    ...runRuleLedger(root, home, env, { record: !isReadOnlyMode() }).results,
    // An installed gate the agent does not run is a false green: Codex needs the user to trust it.
    ...checkCodexHookTrust(root, home, env),
    // Aider commits with --no-verify by default, past kit's git hooks.
    ...checkAiderCommitVerify(root, home, env),
  ];
}
