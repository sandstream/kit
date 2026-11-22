/**
 * exec-broker: observe evidence that rests on a verified audit log.
 *
 * `enforce-readiness.ts` counts the observe events it finds. A count is evidence only when the
 * log it came from verifies: a removed would-be denial, an edited one or an unparseable line
 * must not leave a "ready" verdict behind. This module verifies the hash chain first and gives
 * a broken chain its own verdict, `unverifiable`.
 *
 * Limit: the hash chain does not show a log that lost its last lines. `kit audit verify`
 * finds that with the anchor.
 */
import { verifyAuditChain } from "../audit.js";
import { assessEnforceReadiness, parseObserveRecords } from "./enforce-readiness.js";
import type { EnforceReadiness } from "./enforce-readiness.js";

/** Assess raw audit log content. A broken chain is `unverifiable`, whatever the events say. */
export function assessObserveEvidence(auditJsonl: string): EnforceReadiness {
  const readiness = assessEnforceReadiness(parseObserveRecords(auditJsonl));
  const chain = verifyAuditChain(auditJsonl);
  if (chain.ok) return readiness;
  return {
    ...readiness,
    verdict: "unverifiable",
    evidenceBreak: `entry ${chain.brokenAt}: ${chain.reason}`,
  };
}
