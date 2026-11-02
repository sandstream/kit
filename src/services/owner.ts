/**
 * Who is calling `kit services`: which agent harness, and which session of it.
 *
 * Measured on macOS, 2026-11-01:
 *   - Claude Code 2.1.316 sets `CLAUDE_CODE_SESSION_ID` (the session uuid, the same id the
 *     transcript and hook payloads use) and `CLAUDECODE=1` in every Bash tool subprocess.
 *   - Codex 0.166.0 sets `CODEX_THREAD_ID` and `CODEX_SESSION_ID` (equal values) in every shell
 *     tool subprocess, plus `CODEX_CI=1` and `CODEX_SANDBOX`.
 *
 * Environment variables are inherited, so a Codex started from inside Claude Code sees both sets.
 * The inner harness is the one making the call, and Codex re-sets its variables per tool call,
 * so Codex is checked first. `AI_AGENT` is not used: it leaked from Claude Code into Codex.
 *
 * Hooks get the session id on stdin (`session_id`), which `hookSessionId` prefers over the env.
 */

import type { AgentKind, ServiceOwner } from "./registry.js";

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function detectOwner(env: NodeJS.ProcessEnv = process.env, label?: string): ServiceOwner {
  const owner: ServiceOwner = { agent: "unknown" };
  const codex = nonEmpty(env.CODEX_THREAD_ID) ?? nonEmpty(env.CODEX_SESSION_ID);
  const claude = nonEmpty(env.CLAUDE_CODE_SESSION_ID);
  if (codex) {
    owner.agent = "codex";
    owner.session = codex;
  } else if (claude) {
    owner.agent = "claude";
    owner.session = claude;
  } else if (env.CLAUDECODE === "1") {
    owner.agent = "claude";
  } else if (env.CODEX_CI === "1" || nonEmpty(env.CODEX_SANDBOX)) {
    owner.agent = "codex";
  }
  const l = nonEmpty(label);
  if (l) owner.label = l;
  return owner;
}

/**
 * True when `caller` is the owner of an entry. With a session id on either side, the session ids
 * decide (a different session of the same agent is not the owner). Without one, the agent kind and
 * the `--owner` label decide, so a person working in a plain terminal owns what they registered.
 */
export function sameOwner(owner: ServiceOwner, caller: ServiceOwner): boolean {
  if (owner.session || caller.session) {
    return owner.session === caller.session && owner.agent === caller.agent;
  }
  return owner.agent === caller.agent && (owner.label ?? "") === (caller.label ?? "");
}

export function describeOwner(owner: ServiceOwner): string {
  const parts: string[] = [owner.agent];
  if (owner.session) parts.push(owner.session.slice(0, 8));
  const base = parts.join(":");
  return owner.label ? `${owner.label} (${base})` : base;
}

export function agentFromHarness(harness: string | undefined): AgentKind {
  return harness === "codex" ? "codex" : harness === "claude" ? "claude" : "unknown";
}
