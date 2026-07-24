/**
 * Vendored, pinned AIUC-1 (AI-agent certification standard) as a kit coverage
 * evidence map. Same honesty rule as the OWASP / SSDF maps: kit maps ONLY what its
 * deterministic, local, zero-LLM checks can actually speak to, and buckets each
 * domain honestly (auto / gap / manual / na).
 *
 * IMPORTANT — this is an EVIDENCE map that helps you PREPARE FOR and STAY READY
 * BETWEEN AIUC-1 audits. It is NOT a certificate and NOT a compliance attestation.
 * AIUC-1 certification is issued by the Artificial Intelligence Underwriting
 * Company via an independent third-party audit + quarterly adversarial testing,
 * and is backed by insurance (Lloyd's of London). kit produces evidence; the
 * certificate and the underwriting are theirs.
 *
 * Structure note: AIUC-1's granular controls were NOT first-party verified
 * (aiuc-1.com returned HTTP 403 in this environment, as with the OWASP maps), so
 * this map is at the published DOMAIN level, confirmed via secondary indexes. See
 * the `caveat`.
 *
 * Source: AIUC-1, the Artificial Intelligence Underwriting Company.
 *   - https://www.aiuc-1.com/
 */
import type { StandardDescriptor } from "./standard.js";

const SECTION = "AIUC-1 (AI agent standard)";

export const AIUC_1: StandardDescriptor = {
  key: "aiuc-1",
  label: "AIUC-1 (AI agent standard)",
  version: "2026",
  source: "AIUC-1, the Artificial Intelligence Underwriting Company",
  sourceUrl: "https://www.aiuc-1.com/",
  unit: "domain",
  caveat:
    "Domain-level evidence map (granular controls not first-party verified — aiuc-1.com was HTTP-403 blocked; domains confirmed via secondary indexes). This PREPARES FOR an AIUC-1 audit and helps you stay ready between quarterly tests — it is NOT a certificate or attestation. Certification + underwriting are issued by AIUC via independent third-party audit.",
  requirements: [
    { id: "AIUC-1:SEC", section: SECTION, text: "Security — attack resistance & operational boundaries" },
    { id: "AIUC-1:SAF", section: SECTION, text: "Safety — harm prevention & behavioral controls" },
    { id: "AIUC-1:REL", section: SECTION, text: "Reliability — system dependability & error prevention" },
    { id: "AIUC-1:PRIV", section: SECTION, text: "Data & privacy — protection of sensitive data" },
    { id: "AIUC-1:ACC", section: SECTION, text: "Accountability — traceability & auditability" },
    { id: "AIUC-1:SOC", section: SECTION, text: "Society — broader misuse prevention" },
  ],
  mapping: {
    "AIUC-1:SEC": {
      bucket: "auto",
      checks: ["gate-egress", "gate-fs", "signed scope", "kit triage", "R7", "kit secrets"],
      rationale:
        "Operational boundaries are exactly kit's exec-broker: deny-by-default off-scope egress/fs/secret access under a signed least-privilege scope; kit triage + R7 add attack resistance (tool poisoning, injection). Directly the security-domain controls kit can enforce deterministically.",
    },
    "AIUC-1:SAF": {
      bucket: "gap",
      checks: ["gate-bash", "broker enforce"],
      rationale:
        "Narrow slice: kit denies dangerous/destructive tool actions at the boundary (gate-bash, deny-by-default). Behavioral/content safety (harmful outputs, refusal quality) is a model-side judgement kit deliberately does not make — delegated, not owned.",
    },
    "AIUC-1:REL": {
      bucket: "gap",
      checks: ["fail-closed", "no-false-green"],
      rationale:
        "kit's fail-closed determinism means a check that cannot run fails rather than passing green, which supports error-prevention — but system reliability (uptime, error rates, load behavior) is a runtime/operational property kit does not measure or enforce.",
    },
    "AIUC-1:PRIV": {
      bucket: "auto",
      checks: ["kit secrets", "gate-env", "PII redaction", "scan-transcripts"],
      rationale:
        "kit keeps credentials in the vault and out of the agent loop, blocks plaintext secret writes to .env (gate-env), redacts PII, and scans transcripts/caches for leaked sensitive data — the data-&-privacy controls directly.",
    },
    "AIUC-1:ACC": {
      bucket: "auto",
      checks: ["kit audit", "kit identity", "broker observe"],
      rationale:
        "Every governance decision is recorded to a tamper-evident, hash-chained audit log attributed to a signed identity (incl. observe-mode would-deny events) — traceability/auditability the accountability domain requires, verifiable offline.",
    },
    "AIUC-1:SOC": {
      bucket: "gap",
      checks: [],
      rationale:
        "Broader misuse prevention (societal harm, dual-use, abuse at scale) is a model-behavior and policy judgement kit does not make. kit governs the tool/loop boundary, not the content the model produces.",
    },
  },
};
