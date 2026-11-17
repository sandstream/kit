/**
 * Is this process running inside an agent session? Read from environment variables only, and
 * conservatively: a variable counts only where the harness was measured to set it.
 *
 * - Claude Code sets `CLAUDECODE=1` in every Bash tool subprocess (measured 2.1.316 on macOS,
 *   and in a Claude Code cloud session on Linux, 2026-11).
 * - Codex sets `CODEX_THREAD_ID` in every shell tool subprocess (measured 0.166.0, 2026-11-01;
 *   see `src/services/owner.ts`). Codex is checked first: started from inside Claude Code, it
 *   inherits `CLAUDECODE` too, and the inner harness is the one running the tool call.
 *
 * `CODEX_CI`, `CODEX_SANDBOX` and `AI_AGENT` are not used: the first two are not specific to an
 * interactive session, and `AI_AGENT` leaked from Claude Code into Codex.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type AgentSession = "Claude Code" | "Codex";

export function detectAgentSession(env: NodeJS.ProcessEnv): AgentSession | undefined {
  if (env.CODEX_THREAD_ID?.trim()) return "Codex";
  if (env.CLAUDECODE === "1") return "Claude Code";
  return undefined;
}

/**
 * The fail detail for a kit-managed checkout (`.kit.toml` at `root`) whose gates were never
 * installed, when an agent session is running in it; undefined when the row should still skip.
 */
export function ungatedSessionDetail(root: string, env: NodeJS.ProcessEnv): string | undefined {
  const session = detectAgentSession(env);
  if (!session || !existsSync(join(root, ".kit.toml"))) return undefined;
  return `a ${session} session is running in this kit-managed checkout (.kit.toml) and the enforcement gates were never installed here, so every tool call it makes runs ungated. Run: kit agent-config`;
}
