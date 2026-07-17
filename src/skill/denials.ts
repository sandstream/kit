/**
 * `kit skill test --runtime` — gate-deny evidence from `.kit-audit.jsonl` (denial-based
 * negative controls). Design: `kit-research/docs/research/skill-test-p2-runtime-adherence.md`.
 *
 * A forbidden action that a gate DENIED never runs, so it is not in the transcript's
 * `tool_uses` — it lands in the hash-chained audit log as a `gate-egress`/`gate-fs` deny.
 * This module reads those denies and attributes each to the skill run that was active when it
 * fired, using the `session_id` the gate now stamps on the deny event + the skill's span time
 * windows. That makes the "negative control HELD" evidence session-bounded and precise (a deny
 * credits only the span whose `[start, end)` contains it in the SAME session) — not the fuzzy
 * global timestamp guess that kept this deferred until the join key existed.
 *
 * Pure + tolerant: a missing file is "no denials"; a malformed line is skipped, never thrown.
 */
import type { ObservedAction } from "./adherence.js";
import type { SpanWindow } from "./attribute.js";

/** A gate-deny extracted from the audit log — the join key (`sessionId`) + when + which gate. */
export interface GateDenial {
  sessionId: string;
  timestamp: string;
  gate: string;
}

const DENY_GATES = new Set(["gate-egress", "gate-fs"]);

/**
 * Parse gate-deny records from raw `.kit-audit.jsonl` content. Keeps only PreToolUse denies
 * (`operation` ∈ gate-egress/gate-fs, `success === false`, `metadata.phase === "pretooluse-deny"`)
 * that carry a `session_id` join key. Tolerant: blank/malformed lines are skipped. Pure.
 */
export function parseGateDenials(auditJsonl: string): GateDenial[] {
  const out: GateDenial[] = [];
  for (const line of auditJsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let e: {
      operation?: unknown;
      success?: unknown;
      timestamp?: unknown;
      metadata?: { phase?: unknown; session_id?: unknown };
    };
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip, never throw
    }
    if (typeof e.operation !== "string" || !DENY_GATES.has(e.operation)) continue;
    if (e.success !== false) continue;
    if (!e.metadata || e.metadata.phase !== "pretooluse-deny") continue;
    const sessionId = e.metadata.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    const timestamp = typeof e.timestamp === "string" ? e.timestamp : "";
    out.push({ sessionId, timestamp, gate: e.operation });
  }
  return out;
}

/** True when `ts` falls inside a window `[start, end)` (end === "" means open — until session end). */
function inWindow(ts: string, w: SpanWindow): boolean {
  if (ts < w.start) return false;
  return w.end === "" ? true : ts < w.end;
}

/**
 * Attribute denials to a skill's run windows and emit them as denied, out-of-scope actions —
 * the positive evidence the negative-control check reads. A denial counts only when its
 * `sessionId` matches a window AND its `timestamp` falls in that window. Because a gate denies
 * an action precisely because it was off-scope, each is marked `brokerVerdict: "out-of-scope"`
 * and `denied: true` → `deniedForbidden`, never a `violation`. Pure.
 */
export function denialActionsForSkill(
  windows: SpanWindow[],
  denials: GateDenial[],
): ObservedAction[] {
  const actions: ObservedAction[] = [];
  for (const d of denials) {
    const hit = windows.some((w) => w.sessionId === d.sessionId && inWindow(d.timestamp, w));
    if (hit) actions.push({ tool: d.gate, brokerVerdict: "out-of-scope", denied: true });
  }
  return actions;
}
