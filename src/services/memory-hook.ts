/** The `kit services` parts of `kit memory hook`, kept out of commands/memory.ts. */
import { getCurrentProjectRoot } from "../memory/project.js";
import {
  hookSessionId,
  servicesPromptNotice,
  servicesSessionEnd,
  servicesSessionStart,
} from "./hook.js";

type EndHarness = "claude-code" | "codex";

const SESSION_END_EVENTS = new Map<string, EndHarness>([
  ["session-end", "claude-code"],
  ["session-end-codex", "codex"],
]);

/** Which harness a SessionEnd hook event belongs to, or undefined for any other event. */
export function sessionEndHarness(event: string | undefined): EndHarness | undefined {
  return SESSION_END_EVENTS.get(String(event));
}

/** Stop requests and ending leases for this session. Registry reads only, never docker. */
export async function servicesPromptLines(): Promise<string[]> {
  const line = servicesPromptNotice(await hookSessionId());
  return line ? [line] : [];
}

/** This session's requests and leases, and orphans in this project. */
export async function servicesStartLines(): Promise<string[]> {
  return servicesSessionStart(await hookSessionId(), getCurrentProjectRoot());
}

/** Mark the services this session still owns before the process goes (one file write). */
export async function markServicesAtSessionEnd(): Promise<void> {
  servicesSessionEnd(await hookSessionId());
}
