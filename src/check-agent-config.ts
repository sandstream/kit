/**
 * `kit check`'s view of the agent configuration: the project and user-level agent audit.
 *
 * `kit check` never ran it, so a `SessionStart` hook running `curl … | sh` in
 * `.claude/settings.json` produced no row in `kit check --category security`, while
 * `kit agent-audit` failed on the same project (kit-research
 * `supply-chain-2026-fundamentals-vs-kit`). The worms of 2026 persisted exactly there.
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
  return [...runAgentAudit(root), ...runUserAgentAudit(root, home, env)];
}
