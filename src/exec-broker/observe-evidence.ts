/** Verify the broker's audit snapshot before using its observe records. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyAuditChain } from "../audit.js";
import {
  decideAnchorVerdict,
  readAnchorRecord,
  tryReadProtectedAuditAnchorKey,
  verifyAgainstAnchor,
} from "../audit-anchor.js";
import { canonicalAuditLogPath } from "../audit-log-path.js";
import { assessEnforceReadiness, parseObserveRecords } from "./enforce-readiness.js";
import type { EnforceReadiness, UntestedObserveReason } from "./enforce-readiness.js";

export const BROKER_AUDIT_FILE = ".kit-audit.jsonl";

const untestedMessages: Record<UntestedObserveReason, string> = {
  "missing-log": "The broker audit log is missing",
  "empty-log": "The broker audit log is empty",
  "no-observations": "The broker audit log has no observe events",
};

export function describeUntestedObserveEvidence(reason?: UntestedObserveReason): string {
  return reason ? untestedMessages[reason] : "No observe evidence was recorded";
}

function unverifiable(evidenceBreak: string): EnforceReadiness {
  return { ...assessEnforceReadiness([]), verdict: "unverifiable", evidenceBreak };
}

/** Check chain integrity before extracting records. The caller must still verify the seal. */
export function assessObserveEvidence(auditJsonl: string | undefined): EnforceReadiness {
  if (auditJsonl === undefined) {
    return { ...assessEnforceReadiness([]), untestedReason: "missing-log" };
  }
  const chain = verifyAuditChain(auditJsonl);
  if (!chain.ok) return unverifiable(`entry ${chain.brokenAt}: ${chain.reason}`);
  if (chain.entries === 0) {
    return { ...assessEnforceReadiness([]), untestedReason: "empty-log" };
  }
  const readiness = assessEnforceReadiness(parseObserveRecords(auditJsonl));
  return readiness.verdict === "untested"
    ? { ...readiness, untestedReason: "no-observations" }
    : readiness;
}

/** Read the same project log the broker writes. Never create or advance a seal. */
export async function readObserveReadiness(cwd: string): Promise<EnforceReadiness> {
  const logPath = resolve(cwd, BROKER_AUDIT_FILE);
  let content: string | undefined;
  try {
    content = await readFile(canonicalAuditLogPath(logPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return unverifiable("cannot read the broker audit log as a regular file");
    }
  }

  const readiness = assessObserveEvidence(content);
  if (readiness.verdict === "unverifiable") return readiness;
  try {
    const anchor = await readAnchorRecord(logPath);
    if (!anchor && readiness.verdict === "untested") return readiness;
    if (content === undefined) return unverifiable("the anchored broker audit log is missing");
    const key = anchor ? await tryReadProtectedAuditAnchorKey() : null;
    const result = verifyAgainstAnchor(content, anchor, key);
    const verdict = decideAnchorVerdict({ result, strict: true, machineHasAnchors: false });
    return verdict.ok ? readiness : unverifiable(`audit anchor: ${verdict.message}`);
  } catch {
    return unverifiable("cannot read the audit anchor or its protected key");
  }
}
