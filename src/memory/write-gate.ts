/**
 * kit memory — capture-time WRITE-GATE (G1).
 *
 * Agent memory systems often store rows first and inspect them later, so a poisoned or
 * malformed line can land in the store before anything vets it. This module is the
 * deterministic, fail-closed authorization a memory row must pass BEFORE it is persisted —
 * the "Write Authorization" primitive, reusing kit's existing R7 injection detector and
 * (G2) its plaintext-secret pattern detector (no LLM in the verdict path). Flagging a
 * secret-bearing row keeps a credential from being persisted and later re-injected into a
 * prompt via recall.
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
import { findSecrets } from "../utils/redactSecrets.js";
import type { MessageInput } from "./types.js";

export type WriteGateDecision = "allow" | "quarantine" | "reject";
export type WriteGateReasonCode = "injection" | "oversize" | "schema" | "secret";

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

  // 4. Secret (G2) — a plaintext credential that would otherwise be persisted and
  //    could ride back into a later prompt via recall. Reuses kit's pattern detector; the detail carries
  //    only a masked label/preview, never the raw secret. Skipped when capture-time
  //    redaction already masked it (findSecrets then finds nothing).
  const secrets = content ? findSecrets(content) : [];
  if (secrets.length > 0) {
    const labels = [...new Set(secrets.map((s) => s.label))].join(", ");
    reasons.push({ code: "secret", detail: `plaintext secret(s): ${labels}` });
  }

  let decision: WriteGateDecision;
  if (schemaBad) {
    decision = "reject"; // unstorable in any mode
  } else if (injected || oversize || secrets.length > 0) {
    decision = enforce ? "reject" : "quarantine";
  } else {
    decision = "allow";
  }

  return { decision, reasons };
}
