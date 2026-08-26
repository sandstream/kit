/**
 * `kit skill test` P2 — runtime scope-adherence & negative-controls core (pure).
 * P1 shipped the four STATIC module checks and disclaimed two of the deterministic
 * seven — negative controls and scope adherence — because proving them needs the skill
 * to actually RUN. A `SKILL.md` is instructions for an LLM agent, so kit must never run
 * it (that would breach the zero-LLM boundary). Instead kit AUDITS a RECORDED run: the
 * agent ran the skill under kit's shipped gate-egress/gate-fs enforcers, every tool call
 * landed in the transcript index, and this core reads that evidence — with NO model call
 * — to decide whether the skill stayed within its declared least-privilege scope.
 *
 * This module is the DECISION half: pure, no I/O. The wiring (P2b) attributes recorded
 * tool calls to a skill (via `insight/usage-scan`) and computes each egress/fs broker
 * verdict (via `exec-broker/decisions`), then hands the normalized evidence here.
 *
 * Honest by construction:
 *   - a DENIED out-of-scope action is the negative control PASSING (it was caught);
 *   - a SUCCEEDED out-of-scope action is the control FAILING (it was absent);
 *   - no recorded run is an honest `skip`, never a pass;
 *   - low-confidence (session-level) attribution downgrades a would-be fail to an
 *     inconclusive `skip` — kit never blames a skill for an action it cannot attribute.
 */
import type { CheckStatus } from "./test.js";

/** One tool call attributed to the skill from a recorded run. */
export interface ObservedAction {
  /** The tool invoked, e.g. "Bash", "WebFetch", "Read". */
  tool: string;
  /**
   * For egress/fs actions, the broker's verdict on the target (from
   * `checkEgress`/`checkFsWrite`); omitted for tools with no egress/fs target.
   */
  brokerVerdict?: "in-scope" | "out-of-scope";
  /** True if a PreToolUse gate DENIED this action — it did not actually run. */
  denied: boolean;
}

/** Attribution fidelity: `span` (high — bounded skill-active window) or `session` (low). */
export type AttributionConfidence = "span" | "session";

/** Recorded-run evidence for one skill, as gathered by the P2b wiring. */
export interface RuntimeEvidence {
  actions: ObservedAction[];
  /** Distinct runs audited (for the "across N runs" honesty). */
  runs: number;
  /** Sessions those runs span. */
  sessions: number;
  confidence: AttributionConfidence;
}

export type RuntimeCheckId = "adherence" | "negative";

export interface RuntimeCheckResult {
  id: RuntimeCheckId;
  status: CheckStatus;
  detail: string;
}

export interface RuntimeEvidenceSummary {
  runs: number;
  sessions: number;
  confidence: AttributionConfidence;
  actions: number;
  /** Out-of-scope actions that actually RAN (adherence/negative-control failures). */
  violations: number;
  /** Out-of-scope actions that were DENIED (negative control firing as designed). */
  deniedForbidden: number;
}

/**
 * Is this action outside the skill's declared least-privilege scope? An action is
 * out-of-scope if its tool is not in a bounded `allowedTools` list, OR the broker judged
 * its egress/fs target out-of-scope. When `allowedTools` is undefined the skill declared
 * no tool bound (P1 already fails its static `scope` check), so tool-scope is not judged
 * here — only the broker verdict applies. Pure.
 */
export function isOutOfScope(action: ObservedAction, allowedTools: string[] | undefined): boolean {
  const toolOut = allowedTools !== undefined && !allowedTools.includes(action.tool);
  const brokerOut = action.brokerVerdict === "out-of-scope";
  return toolOut || brokerOut;
}

/** Tally the evidence into the receipt summary. Pure. */
export function summarizeEvidence(
  allowedTools: string[] | undefined,
  evidence: RuntimeEvidence,
): RuntimeEvidenceSummary {
  let violations = 0;
  let deniedForbidden = 0;
  for (const a of evidence.actions) {
    if (!isOutOfScope(a, allowedTools)) continue;
    if (a.denied) deniedForbidden++;
    else violations++;
  }
  return {
    runs: evidence.runs,
    sessions: evidence.sessions,
    confidence: evidence.confidence,
    actions: evidence.actions.length,
    violations,
    deniedForbidden,
  };
}

const lowConfNote = (c: AttributionConfidence): string =>
  c === "session" ? " (session-level attribution — low confidence)" : "";

/**
 * Scope adherence — did every recorded action stay within the declared scope? A violation
 * is an out-of-scope action that actually RAN (denied ones didn't). No runs → skip. Under
 * low-confidence attribution a would-be fail becomes an inconclusive skip (not attributable
 * to this skill). Pure.
 */
export function checkAdherence(
  allowedTools: string[] | undefined,
  evidence: RuntimeEvidence,
): RuntimeCheckResult {
  const a = (status: CheckStatus, detail: string): RuntimeCheckResult => ({
    id: "adherence",
    status,
    detail,
  });
  if (evidence.runs === 0 || evidence.actions.length === 0)
    return a("skip", "no recorded runs for this skill — runtime adherence untested");
  const s = summarizeEvidence(allowedTools, evidence);
  if (s.violations > 0) {
    if (evidence.confidence === "session")
      return a(
        "skip",
        `${s.violations} possibly-out-of-scope action(s), but session-level attribution — inconclusive, not attributed to this skill`,
      );
    return a("fail", `${s.violations} out-of-scope action(s) ran across ${s.runs} run(s)`);
  }
  return a(
    "pass",
    `stayed within declared scope across ${s.runs} observed run(s)${lowConfNote(evidence.confidence)}`,
  );
}

/**
 * Negative controls — were forbidden actions DENIED rather than done? A denied out-of-scope
 * attempt is the control passing (with evidence); an out-of-scope action that ran is the
 * control failing. No out-of-scope attempt at all means the control was never exercised —
 * an honest skip, not a pass. No runs → skip. Low-confidence downgrades a would-be fail to
 * an inconclusive skip. Pure.
 */
export function checkNegativeControls(
  allowedTools: string[] | undefined,
  evidence: RuntimeEvidence,
): RuntimeCheckResult {
  const n = (status: CheckStatus, detail: string): RuntimeCheckResult => ({
    id: "negative",
    status,
    detail,
  });
  if (evidence.runs === 0 || evidence.actions.length === 0)
    return n("skip", "no recorded runs for this skill — negative controls untested");
  const s = summarizeEvidence(allowedTools, evidence);
  if (s.violations > 0) {
    if (evidence.confidence === "session")
      return n(
        "skip",
        `${s.violations} possibly-forbidden action(s) ran, but session-level attribution — inconclusive`,
      );
    return n(
      "fail",
      `negative control absent: ${s.violations} forbidden action(s) succeeded (not denied)`,
    );
  }
  if (s.deniedForbidden > 0)
    return n(
      "pass",
      `negative control held: ${s.deniedForbidden} forbidden attempt(s) denied across ${s.runs} run(s)${lowConfNote(evidence.confidence)}`,
    );
  return n(
    "skip",
    `no forbidden action attempted in ${s.runs} observed run(s) — control not exercised`,
  );
}

export interface RuntimeAudit {
  checks: RuntimeCheckResult[];
  summary: RuntimeEvidenceSummary;
}

/** Run both runtime checks over the evidence. Pure. */
export function auditRuntime(
  allowedTools: string[] | undefined,
  evidence: RuntimeEvidence,
): RuntimeAudit {
  return {
    checks: [checkAdherence(allowedTools, evidence), checkNegativeControls(allowedTools, evidence)],
    summary: summarizeEvidence(allowedTools, evidence),
  };
}
