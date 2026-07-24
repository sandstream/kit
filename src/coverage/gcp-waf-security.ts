/**
 * Vendored, pinned Google Cloud Well-Architected Framework — Security (privacy &
 * compliance) pillar — as a kit coverage evidence map. Same honesty rule as the
 * OWASP / SSDF / AIUC-1 maps: kit maps ONLY what its deterministic, local,
 * zero-LLM checks can actually speak to, and buckets each principle honestly.
 *
 * This complements (does not replace) Google's own WAF Security skill: the skill
 * DRAFTS an interactive assessment with an LLM; this is the DETERMINISTIC evidence
 * a GRC tool can ingest. It is an evidence map, NOT a compliance attestation.
 *
 * Structure note: mapped at the pillar's core-PRINCIPLE level (not per-
 * recommendation). Principles confirmed via the Google Cloud Architecture Center
 * docs index; the first-party per-recommendation pages were not exhaustively
 * verified in this environment. See the `caveat`.
 *
 * Source: Google Cloud Well-Architected Framework — Security, privacy, and
 * compliance pillar.
 *   - https://docs.cloud.google.com/architecture/framework/security
 */
import type { StandardDescriptor } from "./standard.js";

const SECTION = "GCP WAF — Security pillar";

export const GCP_WAF_SECURITY: StandardDescriptor = {
  key: "gcp-waf-security",
  label: "GCP Well-Architected — Security pillar",
  version: "2026",
  source: "Google Cloud Well-Architected Framework — Security, privacy & compliance pillar",
  sourceUrl: "https://docs.cloud.google.com/architecture/framework/security",
  unit: "principle",
  caveat:
    "Principle-level evidence map (not per-recommendation; principles confirmed via the GCP Architecture Center docs index, not exhaustively per-page verified). Complements Google's LLM-drafted WAF Security skill with deterministic evidence; NOT a compliance attestation.",
  requirements: [
    { id: "GWAF-SEC:DESIGN", section: SECTION, text: "Implement security by design" },
    { id: "GWAF-SEC:ZEROTRUST", section: SECTION, text: "Implement zero trust" },
    { id: "GWAF-SEC:SHIFTLEFT", section: SECTION, text: "Implement shift-left security" },
    { id: "GWAF-SEC:PREEMPTIVE", section: SECTION, text: "Implement preemptive cyber defense" },
    { id: "GWAF-SEC:AI-SECURE", section: SECTION, text: "Use AI securely and responsibly" },
    { id: "GWAF-SEC:AI-FOR-SEC", section: SECTION, text: "Use AI for security" },
    { id: "GWAF-SEC:COMPLIANCE", section: SECTION, text: "Meet regulatory, compliance, and privacy needs" },
  ],
  mapping: {
    "GWAF-SEC:DESIGN": {
      bucket: "manual",
      checks: [],
      rationale:
        "kit supplies the scaffolding for security-by-design (a declared least-privilege scope, a standards baseline, a versioned profile), but whether the application/infrastructure was actually designed securely is a human architecture judgement kit surfaces evidence for, not one it decides.",
    },
    "GWAF-SEC:ZEROTRUST": {
      bucket: "auto",
      checks: ["gate-egress", "gate-fs", "signed scope", "kit context check", "broker enforce"],
      rationale:
        "The exec-broker is never-trust-always-verify by construction: no verified scope grants nothing, egress/fs/secret access is denied by default off-scope, and per-CLI context-lock verifies each tool points at the declared account/project — zero-trust at the agent-tool boundary.",
    },
    "GWAF-SEC:SHIFTLEFT": {
      bucket: "auto",
      checks: ["kit check", "kit review", "kit standards", "kit triage", "hooks"],
      rationale:
        "Shifting security left is kit's whole premise: the deterministic gate (check/review/standards/triage) runs in pre-commit hooks and CI before code or an install lands — controls early in the SDLC, fail-closed.",
    },
    "GWAF-SEC:PREEMPTIVE": {
      bucket: "gap",
      checks: ["R7", "kit triage", "kit scan"],
      rationale:
        "kit adds preemptive elements — injection detection (R7), pre-install triage, merged scanner verdicts — but proactive threat hunting, red-team exercises, and detonation are broader operational practices kit does not run.",
    },
    "GWAF-SEC:AI-SECURE": {
      bucket: "auto",
      checks: ["exec-broker", "kit triage skill", "kit triage mcp", "kit secrets", "install-gate"],
      rationale:
        "Using AI securely is exactly kit's core: govern the agent loop — least-privilege scope, triage of skills/MCP/packages before use, secrets kept out of the loop, un-triaged installs blocked. Deterministic and fail-closed.",
    },
    "GWAF-SEC:AI-FOR-SEC": {
      bucket: "na",
      checks: [],
      rationale:
        "Out of scope by charter: kit is zero-LLM and deterministic. It deliberately does NOT use AI to make security decisions — it delegates any LLM-based detection to best-of-breed tools and never runs their model stage, keeping its own verdict reproducible (no false green).",
    },
    "GWAF-SEC:COMPLIANCE": {
      bucket: "manual",
      checks: [],
      rationale:
        "kit enforces concrete privacy controls (vaulted secrets, PII redaction) and emits coverage evidence maps + a tamper-evident audit trail a GRC tool ingests — but meeting a specific regulation/compliance regime is an external attestation kit prepares for, never asserts.",
    },
  },
};
