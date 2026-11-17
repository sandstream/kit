/**
 * The stop switch: one marker file that makes every PreToolUse gate refuse every tool call.
 *
 * kit-research `agent-swarms-security-guide-vs-kit`: the guide asks for a rehearsed way to stop
 * the whole job. `kit panic` rotated keys and printed a checklist, but did not stop agents that
 * were already running. `kit panic --stop` writes `~/.kit/stop`; `runGateFailClosed` reads it
 * before any gate decision, so each gated agent on the machine is refused at its next tool call.
 * `kit panic --resume` removes it. Machine-wide on purpose: a compromise is not per project.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StopState {
  since: string;
  reason: string;
}

export function stopMarkerPath(home: string): string {
  return join(home, ".kit", "stop");
}

/** The stop in effect, or null. An unreadable or malformed marker still stops (fail closed). */
export function readStop(home: string): StopState | null {
  const path = stopMarkerPath(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StopState>;
    return {
      since: typeof parsed.since === "string" ? parsed.since : "unknown",
      reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
    };
  } catch {
    return { since: "unknown", reason: "stop marker present (unreadable)" };
  }
}

export function writeStop(home: string, reason: string, now: Date = new Date()): StopState {
  const state: StopState = { since: now.toISOString(), reason };
  const path = stopMarkerPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state) + "\n", { encoding: "utf8", mode: 0o600 });
  return state;
}

/** Remove the marker; false when there was none. */
export function clearStop(home: string): boolean {
  const path = stopMarkerPath(home);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
