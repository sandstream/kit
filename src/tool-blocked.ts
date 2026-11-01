import { triageTargetFor } from "./triage-gate.js";

/** Why a missing tool is missing, when `kit install` would refuse it rather than skip it. */
export function blockedByTriageNote(name: string, installed: string | null): string | undefined {
  if (installed !== null || triageTargetFor(name).kind !== "untriageable") return undefined;
  return `no backend prefix: kit install refuses ${name} (fail-closed); declare it as pipx:${name}, npm:${name} or similar`;
}
