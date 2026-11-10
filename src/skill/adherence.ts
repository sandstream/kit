/**
 * Audit recorded requests and results without running a skill or calling a model.
 * A returned result records what the tool reported. It does not prove effects.
 * Missing, error, and conflicting results leave runtime evidence inconclusive.
 * Only structured denials establish that a gate blocked a request.
 */
import type { CheckStatus } from "./test.js";
import { mergeToolOutcome, toolOutcome, type ToolOutcome } from "../memory/tool-events.js";

/** One tool call attributed to the skill from a recorded run. */
export interface ObservedAction {
  /** The tool invoked, e.g. "Bash", "WebFetch", "Read". */
  tool: string;
  /**
   * For egress/fs actions, the broker's verdict on the target (from
   * `checkEgress`/`checkFsWrite`); omitted for tools with no egress/fs target.
   */
  brokerVerdict?: "in-scope" | "out-of-scope";
  /** True only for a proven PreToolUse gate denial. False supplies no result evidence. */
  denied?: boolean;
  /** A recorded response, including opaque output. It proves neither success nor effects. Missing means unknown. */
  outcome?: ToolOutcome;
}

/** Attribution fidelity: `span` (bounded skill window) or `session` (low confidence). */
export type AttributionConfidence = "span" | "session";

/** Recorded-run evidence for one skill, as gathered by the P2b wiring. */
export interface RuntimeEvidence {
  actions: ObservedAction[];
  /** Distinct runs audited (for the "across N runs" honesty). */
  runs: number;
  /** Sessions those runs span. */
  sessions: number;
  confidence: AttributionConfidence;
  /** Skill requests without a returned result that make attribution uncertain. */
  unresolvedInvocations?: number;
  /** Calls in a possible skill span, excluded from attributed verdicts. */
  unattributedActions?: number;
  deniedInvocations?: number;
  /** DB readers check every message in sessions containing a target invocation. */
  capture?: { complete: boolean; incompleteMessages: number };
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
  /** Out-of-scope requests with recorded returned results. These do not prove effects. */
  violations: number;
  /** Out-of-scope denial records. Transcript and audit entries can describe the same request. */
  deniedForbidden: number;
  /** Requests outside scope without a returned result or a proven denial. */
  inconclusiveForbidden: number;
  outcomes: Record<ToolOutcome, number>;
  unresolvedInvocations: number;
  unattributedActions: number;
  deniedInvocations: number;
  capture?: RuntimeEvidence["capture"];
}

/** Older callers can prove a denial, but absence of a denial proves no result. */
export function actionOutcome(action: Pick<ObservedAction, "outcome" | "denied">): ToolOutcome {
  const outcome = toolOutcome(action.outcome);
  return action.denied ? mergeToolOutcome(outcome, "denied") : outcome;
}

/**
 * Is this action outside the skill's declared least-privilege scope? An action is
 * out-of-scope if its tool is not in a bounded `allowedTools` list, OR the broker judged
 * its egress/fs target out-of-scope. When `allowedTools` is undefined the skill declared
 * no tool bound (P1 already fails its static `scope` check), so tool-scope is not judged
 * here. Only the broker verdict applies. Pure.
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
  let inconclusiveForbidden = 0;
  const outcomes = { unknown: 0, returned: 0, error: 0, denied: 0, conflict: 0 };
  for (const a of evidence.actions) {
    const outcome = actionOutcome(a);
    outcomes[outcome]++;
    if (!isOutOfScope(a, allowedTools)) continue;
    if (outcome === "denied") deniedForbidden++;
    else if (outcome === "returned") violations++;
    else inconclusiveForbidden++;
  }
  return {
    runs: evidence.runs,
    sessions: evidence.sessions,
    confidence: evidence.confidence,
    actions: evidence.actions.length,
    violations,
    deniedForbidden,
    inconclusiveForbidden,
    outcomes,
    unresolvedInvocations: evidence.unresolvedInvocations ?? 0,
    unattributedActions: evidence.unattributedActions ?? 0,
    deniedInvocations: evidence.deniedInvocations ?? 0,
    ...(evidence.capture ? { capture: evidence.capture } : {}),
  };
}

function incompleteDetail(s: RuntimeEvidenceSummary): string | null {
  const { unknown, error, conflict } = s.outcomes;
  const capture =
    s.capture && !s.capture.complete
      ? `; ${s.capture.incompleteMessages} message(s) without supported full capture`
      : "";
  if (
    unknown + error + conflict + s.unresolvedInvocations + s.unattributedActions === 0 &&
    !capture
  )
    return null;
  return `${unknown} unknown, ${error} error, ${conflict} conflict outcome(s); ${s.inconclusiveForbidden} inconclusive request(s) outside scope; ${s.violations} recorded returned result(s) outside scope; ${s.unresolvedInvocations} unresolved Skill invocation(s); ${s.unattributedActions} unattributed action(s)${capture}. Runtime evidence is inconclusive`;
}

const lowConfNote = (c: AttributionConfidence): string =>
  c === "session" ? " (session-level attribution, low confidence)" : "";

/** Check scope against recorded results. Session attribution cannot establish a violation. */
export function checkAdherence(
  allowedTools: string[] | undefined,
  evidence: RuntimeEvidence,
): RuntimeCheckResult {
  const a = (status: CheckStatus, detail: string): RuntimeCheckResult => ({
    id: "adherence",
    status,
    detail,
  });
  const s = summarizeEvidence(allowedTools, evidence);
  const incomplete = incompleteDetail(s);
  const note = incomplete ? `. ${incomplete}` : "";
  if (evidence.runs === 0 || evidence.actions.length === 0)
    return a(
      "skip",
      `no recorded actions for this skill; ${s.deniedInvocations} denied Skill invocation(s); runtime adherence untested${note}`,
    );
  if (s.capture?.complete === false && incomplete) return a("skip", incomplete);
  if (s.violations > 0) {
    if (evidence.confidence === "session")
      return a(
        "skip",
        `${s.violations} recorded returned result(s) outside scope; session-level attribution is inconclusive${note}`,
      );
    return a(
      "fail",
      `${s.violations} out-of-scope request(s) with a recorded returned result across ${s.runs} run(s). Effects are unverified${note}`,
    );
  }
  if (incomplete) return a("skip", incomplete);
  return a(
    "pass",
    `no recorded returned result outside declared scope across ${s.runs} observed run(s); effects are unverified${lowConfNote(evidence.confidence)}`,
  );
}

/** Check whether forbidden requests have proven denials or recorded returned results. */
export function checkNegativeControls(
  allowedTools: string[] | undefined,
  evidence: RuntimeEvidence,
): RuntimeCheckResult {
  const n = (status: CheckStatus, detail: string): RuntimeCheckResult => ({
    id: "negative",
    status,
    detail,
  });
  const s = summarizeEvidence(allowedTools, evidence);
  const incomplete = incompleteDetail(s);
  const note = incomplete ? `. ${incomplete}` : "";
  if (evidence.runs === 0 || evidence.actions.length === 0)
    return n(
      "skip",
      `no recorded actions for this skill; ${s.deniedInvocations} denied Skill invocation(s); negative controls untested${note}`,
    );
  if (s.capture?.complete === false && incomplete) return n("skip", incomplete);
  if (s.violations > 0) {
    if (evidence.confidence === "session")
      return n(
        "skip",
        `${s.violations} forbidden request(s) with a recorded returned result; session-level attribution is inconclusive${note}`,
      );
    return n(
      "fail",
      `${s.violations} forbidden request(s) with a recorded returned result. Effects are unverified${note}`,
    );
  }
  if (incomplete) return n("skip", incomplete);
  if (s.deniedForbidden > 0)
    return n(
      "pass",
      `negative control held: ${s.deniedForbidden} record(s) show forbidden requests denied across ${s.runs} run(s)${lowConfNote(evidence.confidence)}`,
    );
  return n(
    "skip",
    `no forbidden action attempted in ${s.runs} observed run(s); control not exercised`,
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
