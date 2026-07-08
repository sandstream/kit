/**
 * kit memory — capture-time WRITE-GATE (G1).
 *
 * The gap analysis (kit-research docs/research/agent-security-gap-analysis.md §2.1,
 * verified 3-0) found that WRITE-GATE VALIDATION is an industry-wide blind spot in
 * agent memory: rows are stored first and inspected later, so a poisoned or malformed
 * line lands in the store before anything vets it. This module is the deterministic,
 * fail-closed authorization a memory row must pass BEFORE it is persisted — the
 * "Write Authorization" primitive, reusing kit's existing R7 injection detector
 * (no LLM in the verdict path).
 *
 * Two modes, secure-by-default (warn), matching the warn→enforce ramp `kit standards`
 * uses:
 *   - warn (default): a flagged row is QUARANTINED — stored but excluded from recall.
 *     This is identical to kit's prior on-insert behavior, so enabling the gate is a
 *     no-op for existing stores; no data is lost.
 *   - enforce (KIT_MEMORY_WRITE_ENFORCE=1): a flagged row is REJECTED — never
 *     persisted. The gate has teeth.
 * A schema-invalid row (missing the identifiers that make it attributable and
 * idempotent) is REJECTED in both modes: it cannot be stored validly or audited.
 *
 * `evaluateWriteGate` is pure and never throws; `insertMessage` fails closed toward
 * the prompt on any unexpected evaluation error (quarantine in warn, reject in enforce).
 */
import { findInjection } from "./injection.js";
import type { MessageInput } from "./types.js";

export type WriteGateDecision = "allow" | "quarantine" | "reject";
export type WriteGateReasonCode = "injection" | "oversize" | "schema";

export interface WriteGateReason {
  code: WriteGateReasonCode;
  detail: string;
}

export interface WriteGateVerdict {
  decision: WriteGateDecision;
  reasons: WriteGateReason[];
}

/**
 * Hard ceiling on a single stored message (bytes). A row past this is treated as
 * an abusive context-flooding / memory-poisoning vector, not as content. Generous
 * so real transcripts never trip it.
 */
export const MAX_CONTENT_BYTES = 5_000_000; // 5 MB

/** True when the write-gate should REJECT flagged rows instead of quarantining them. */
export function writeGateEnforcing(): boolean {
  return ["1", "true", "yes"].includes(
    (process.env.KIT_MEMORY_WRITE_ENFORCE ?? "").trim().toLowerCase(),
  );
}

/**
 * Evaluate a memory row against the capture-time write-gate. Pure + deterministic;
 * never throws. `content` is the text that would actually be stored (i.e. after any
 * capture-time redaction), so the gate judges what lands, not what arrived.
 */
export function evaluateWriteGate(
  m: MessageInput,
  content: string | null,
  opts: { enforce?: boolean } = {},
): WriteGateVerdict {
  const enforce = opts.enforce ?? writeGateEnforcing();
  const reasons: WriteGateReason[] = [];

  // 1. Schema / provenance — a row must carry the identifiers that make it
  //    attributable (sessionId), idempotent (uuid) and typed (type). These are
  //    NOT NULL in the schema, so a missing one is both unstorable and unauditable:
  //    reject in every mode rather than throw at the DB layer.
  let schemaBad = false;
  if (!m.uuid || !m.uuid.trim()) {
    reasons.push({ code: "schema", detail: "missing uuid" });
    schemaBad = true;
  }
  if (!m.sessionId || !m.sessionId.trim()) {
    reasons.push({ code: "schema", detail: "missing sessionId" });
    schemaBad = true;
  }
  if (!m.type || !m.type.trim()) {
    reasons.push({ code: "schema", detail: "missing type" });
    schemaBad = true;
  }

  // 2. Oversize — a single row past the ceiling is a flooding vector.
  const bytes = content ? Buffer.byteLength(content, "utf8") : 0;
  const oversize = bytes > MAX_CONTENT_BYTES;
  if (oversize) {
    reasons.push({ code: "oversize", detail: `${bytes} bytes > ${MAX_CONTENT_BYTES} limit` });
  }

  // 3. Injection (R7) — a high-confidence prompt-injection pattern in the content.
  const injected = !!content && findInjection(content).some((f) => f.confidence === "high");
  if (injected) {
    reasons.push({ code: "injection", detail: "high-confidence prompt-injection pattern" });
  }

  let decision: WriteGateDecision;
  if (schemaBad) {
    decision = "reject"; // unstorable in any mode
  } else if (injected || oversize) {
    decision = enforce ? "reject" : "quarantine";
  } else {
    decision = "allow";
  }

  return { decision, reasons };
}
