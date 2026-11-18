/**
 * Per-session limits for an agent run: wall-clock minutes, tool calls, and child agents.
 *
 * kit-research `agent-swarms-security-guide-vs-kit`: the guide asks for limits on elapsed time,
 * tool calls and child agents. `[governance.agent]` had per-day tokens and per-hour operations
 * only. `kit gate-limits` (opt-in, every tool) counts each session's calls in
 * `~/.kit/sessions/<hash>.json` and refuses once a limit in `.kit.toml` is reached:
 *
 *   [governance.agent]
 *   max_session_minutes = 120
 *   max_tool_calls_per_session = 500
 *   max_child_agents = 4
 *
 * The decision is pure (`decideSessionLimits`); the state file is best-effort. Two tool calls of
 * one session running at the same moment can both be counted from the same state, so a limit can
 * be passed by the number of parallel calls. A payload without a session id is not counted.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SessionLimits {
  maxSessionMinutes?: number;
  maxToolCalls?: number;
  maxChildAgents?: number;
}

export interface SessionState {
  start: string;
  calls: number;
  agents: number;
}

/** Tools that start another agent. */
const AGENT_TOOLS = new Set(["Task", "Agent"]);

export function hasLimits(limits: SessionLimits): boolean {
  return (
    limits.maxSessionMinutes !== undefined ||
    limits.maxToolCalls !== undefined ||
    limits.maxChildAgents !== undefined
  );
}

/** The refusal for this call, or the state after counting it. Pure. */
export function decideSessionLimits(
  limits: SessionLimits,
  state: SessionState | null,
  tool: string,
  now: Date,
): { refuse: string } | { next: SessionState } {
  const current = state ?? { start: now.toISOString(), calls: 0, agents: 0 };
  const minutes = (now.getTime() - Date.parse(current.start)) / 60_000;
  if (limits.maxSessionMinutes !== undefined && minutes >= limits.maxSessionMinutes) {
    return {
      refuse: `the session has run ${Math.floor(minutes)} min (limit ${limits.maxSessionMinutes})`,
    };
  }
  if (limits.maxToolCalls !== undefined && current.calls >= limits.maxToolCalls) {
    return {
      refuse: `the session has made ${current.calls} tool calls (limit ${limits.maxToolCalls})`,
    };
  }
  const spawns = AGENT_TOOLS.has(tool);
  if (spawns && limits.maxChildAgents !== undefined && current.agents >= limits.maxChildAgents) {
    return {
      refuse: `the session has started ${current.agents} agents (limit ${limits.maxChildAgents})`,
    };
  }
  return {
    next: { ...current, calls: current.calls + 1, agents: current.agents + (spawns ? 1 : 0) },
  };
}

/** Where one session's counters live; the id is hashed so it never becomes a path. */
export function sessionStatePath(home: string, sessionId: string): string {
  const name = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(home, ".kit", "sessions", `${name}.json`);
}

export function readSessionState(path: string): SessionState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionState>;
    if (typeof parsed.start !== "string" || Number.isNaN(Date.parse(parsed.start))) return null;
    return {
      start: parsed.start,
      calls: Number.isSafeInteger(parsed.calls) ? (parsed.calls as number) : 0,
      agents: Number.isSafeInteger(parsed.agents) ? (parsed.agents as number) : 0,
    };
  } catch {
    return null;
  }
}

export function writeSessionState(path: string, state: SessionState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state) + "\n", { encoding: "utf8", mode: 0o600 });
}
