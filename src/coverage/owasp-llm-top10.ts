/**
 * Vendored, pinned OWASP Top 10 for LLM Applications (2025) as a kit coverage
 * evidence map. Same honesty rule as the ASVS subset: kit maps ONLY what its
 * deterministic, local, zero-LLM checks can actually speak to, and buckets each
 * risk honestly (auto / gap / manual / na). This is an EVIDENCE source, not a
 * compliance attestation.
 *
 * Control ids/titles were confirmed against genai.owasp.org via search index
 * (the session egress policy blocked first-party fetch of owasp.org); 7/10 titles
 * are verbatim-confirmed, LLM01/03/05 are from the authoritative summary list. See
 * the `caveat` on the descriptor.
 *
 * Source: OWASP Top 10 for LLM Applications 2025 (OWASP GenAI Security Project).
 *   - https://genai.owasp.org/llm-top-10/
 */
import type { StandardDescriptor } from "./standard.js";

export const OWASP_LLM_TOP10: StandardDescriptor = {
  key: "llm-top10",
  label: "OWASP Top 10 for LLM Applications",
  version: "2025",
  source: "OWASP Top 10 for LLM Applications 2025 (OWASP GenAI Security Project)",
  sourceUrl: "https://genai.owasp.org/llm-top-10/",
  unit: "risk",
  caveat:
    "Titles confirmed via search index (owasp.org first-party fetch was egress-blocked); LLM01/03/05 are from the authoritative summary list, not per-page verified.",
  requirements: [
    { id: "LLM01:2025", section: "OWASP LLM Top 10 (2025)", text: "Prompt Injection" },
    { id: "LLM02:2025", section: "OWASP LLM Top 10 (2025)", text: "Sensitive Information Disclosure" },
    { id: "LLM03:2025", section: "OWASP LLM Top 10 (2025)", text: "Supply Chain" },
    { id: "LLM04:2025", section: "OWASP LLM Top 10 (2025)", text: "Data and Model Poisoning" },
    { id: "LLM05:2025", section: "OWASP LLM Top 10 (2025)", text: "Improper Output Handling" },
    { id: "LLM06:2025", section: "OWASP LLM Top 10 (2025)", text: "Excessive Agency" },
    { id: "LLM07:2025", section: "OWASP LLM Top 10 (2025)", text: "System Prompt Leakage" },
    { id: "LLM08:2025", section: "OWASP LLM Top 10 (2025)", text: "Vector and Embedding Weaknesses" },
    { id: "LLM09:2025", section: "OWASP LLM Top 10 (2025)", text: "Misinformation" },
    { id: "LLM10:2025", section: "OWASP LLM Top 10 (2025)", text: "Unbounded Consumption" },
  ],
  mapping: {
    "LLM01:2025": {
      bucket: "auto",
      checks: ["memory injection", "kit triage mcp", "R7"],
      rationale:
        "kit quarantines high-confidence prompt-injection patterns at memory capture (R7) and statically flags tool-metadata poisoning in MCP servers; it does not claim to stop injection inside the model.",
    },
    "LLM02:2025": {
      bucket: "auto",
      checks: ["secrets scan", "gate-env", "scan-transcripts", "R2-secret-argv"],
      rationale:
        "kit detects/redacts plaintext secrets, blocks secret writes to .env (gate-env), flags secret-shaped rows at memory capture, and scans transcripts/caches for leaked credentials.",
    },
    "LLM03:2025": {
      bucket: "auto",
      checks: ["supply-chain", "kit slopsquat", "kit triage mcp", "pinned versions", "sbom"],
      rationale:
        "kit gates un-triaged installs, scores hallucination/slopsquat risk, triages MCP servers, verifies pinned/locked deps, and emits an SBOM (incl. the agent toolchain).",
    },
    "LLM04:2025": {
      bucket: "auto",
      checks: ["memory injection", "memory write-gate"],
      rationale:
        "Narrow slice: kit addresses AGENT-MEMORY poisoning — a capture-time write-gate rejects/quarantines poisoned rows and verified-forget proves removal. Training-data / model-weight poisoning is outside kit's local reach.",
    },
    "LLM05:2025": {
      bucket: "gap",
      checks: [],
      rationale:
        "kit sanitizes its OWN recall/inject path (strips hidden chars, flags), but has no check for how the target application handles/encodes downstream LLM output.",
    },
    "LLM06:2025": {
      bucket: "auto",
      checks: ["gate-bash", "gate-env", "agent-audit"],
      rationale:
        "kit constrains agent agency at the action boundary — deny-by-default installs/secret-writes (PreToolUse gates) and governed mutating MCP tools. Full exec-time agency scoping (egress/fs/secret-scoped broker) is on the 5.0 roadmap.",
    },
    "LLM07:2025": {
      bucket: "gap",
      checks: [],
      rationale:
        "kit scans transcripts/configs for credentials that should not sit in prompts, but has no dedicated system-prompt-leakage detection.",
    },
    "LLM08:2025": {
      bucket: "na",
      checks: [],
      rationale:
        "kit has no RAG / vector-store surface; embedding and retrieval weaknesses are outside its local, static scope.",
    },
    "LLM09:2025": {
      bucket: "na",
      checks: [],
      rationale:
        "kit deliberately does not judge output truthfulness (zero-LLM). The specific package-hallucination vector IS covered deterministically by slopsquat under LLM03.",
    },
    "LLM10:2025": {
      bucket: "gap",
      checks: [],
      rationale:
        "kit has cost/budget signals but no deterministic unbounded-consumption (rate/DoS/cost) gate for the agent runtime.",
    },
  },
};
