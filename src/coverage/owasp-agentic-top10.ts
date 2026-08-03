/**
 * Vendored, pinned OWASP Top 10 for Agentic Applications (2026) as a kit coverage
 * evidence map. Same honesty rule as the ASVS / LLM-Top10 / MCP-Top10 maps: kit
 * maps ONLY what its deterministic, local, zero-LLM checks can actually speak to,
 * and buckets each risk honestly (auto / gap / manual / na). This is an EVIDENCE
 * source, not a compliance attestation.
 *
 * This is the standard native to kit's own lane (agent runtime governance), so the
 * map is deliberately honest about where kit is strong (tool-misuse, identity/
 * privilege, supply chain, memory poisoning, audit) and where it structurally does
 * NOT reach (inter-agent comms, cascading failures, human-trust exploitation,
 * rogue-agent detection).
 *
 * Control ids/titles confirmed against multiple secondary indexes (owasp.org /
 * genai.owasp.org first-party fetch returned HTTP 403 in this environment). See
 * the `caveat`.
 *
 * Source: OWASP Top 10 for Agentic Applications (2026), OWASP GenAI Security Project.
 *   - https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
 */
import type { StandardDescriptor } from "./standard.js";

const SECTION = "OWASP Top 10 for Agentic Applications (2026)";

export const OWASP_AGENTIC_TOP10: StandardDescriptor = {
  key: "agentic-top10",
  label: "OWASP Top 10 for Agentic Applications",
  version: "2026",
  source: "OWASP Top 10 for Agentic Applications 2026 (OWASP GenAI Security Project)",
  sourceUrl: "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/",
  unit: "risk",
  caveat:
    "Ids/titles confirmed via secondary indexes (owasp.org/genai.owasp.org first-party fetch was HTTP-403 blocked), not per-page verified; the ASI ordering is as reported and may differ from the final print.",
  requirements: [
    { id: "ASI01", section: SECTION, text: "Agent Goal Hijack" },
    { id: "ASI02", section: SECTION, text: "Tool Misuse & Exploitation" },
    { id: "ASI03", section: SECTION, text: "Identity & Privilege Abuse" },
    { id: "ASI04", section: SECTION, text: "Agentic Supply Chain Vulnerabilities" },
    { id: "ASI05", section: SECTION, text: "Unexpected Code Execution (RCE)" },
    { id: "ASI06", section: SECTION, text: "Memory & Context Poisoning" },
    { id: "ASI07", section: SECTION, text: "Insecure Inter-Agent Communication" },
    { id: "ASI08", section: SECTION, text: "Cascading Failures" },
    { id: "ASI09", section: SECTION, text: "Human-Agent Trust Exploitation" },
    { id: "ASI10", section: SECTION, text: "Rogue Agents" },
  ],
  mapping: {
    ASI01: {
      bucket: "auto",
      checks: ["memory injection", "R7", "kit triage mcp"],
      rationale:
        "kit quarantines high-confidence prompt-injection at memory capture (R7) and statically flags tool-metadata poisoning that would redirect goals; it does not claim to stop goal hijack reasoned inside the model.",
    },
    ASI02: {
      bucket: "auto",
      checks: ["gate-bash", "gate-egress", "gate-fs", "broker enforce", "agent-audit"],
      rationale:
        "Tool misuse is exactly the exec-broker's job: the signed scope denies off-scope egress/fs and dangerous exec at the tool boundary, observe→enforce graduates it, and mutating MCP tools are governed — deny-by-default with the reason returned to the agent.",
    },
    ASI03: {
      bucket: "auto",
      checks: ["kit secrets", "gate-env", "signed scope"],
      rationale:
        "kit keeps credentials in the vault and out of the agent loop, and signs a least-privilege scope — directly the identity/privilege-abuse risk. Keyless (RFC 9421) egress is NOT shipped, so a leaked static token is mitigated by vault custody and scope, not by request signing.",
    },
    ASI04: {
      bucket: "auto",
      checks: ["supply-chain", "kit slopsquat", "kit triage", "pinned versions", "sbom"],
      rationale:
        "kit gates un-triaged installs, scores slopsquat risk, triages skills/MCP/plugins/repos, verifies pinned/locked deps, and emits an agent-toolchain SBOM — the agentic supply-chain surface.",
    },
    ASI05: {
      bucket: "auto",
      checks: ["gate-bash", "install-gate"],
      rationale:
        "Narrow slice: kit denies dangerous/un-triaged command and install execution the agent attempts (deny-by-default gates). RCE reachable through the target application's own code is outside kit's local static scope.",
    },
    ASI06: {
      bucket: "auto",
      checks: ["memory write-gate", "memory injection", "verified-forget"],
      rationale:
        "kit's strongest coverage: a capture-time write-gate rejects/quarantines poisoned memory rows, R7 strips injection on the recall path, and verified-forget proves removal — agent memory/context poisoning head-on.",
    },
    ASI07: {
      bucket: "gap",
      checks: [],
      rationale:
        "kit governs a single agent's tool calls; an off-scope agent-to-agent call would be seen by the egress gate, but kit has no inter-agent-protocol (A2A) integrity/authentication check.",
    },
    ASI08: {
      bucket: "gap",
      checks: [],
      rationale:
        "kit's fail-closed posture and observe→enforce limit blast radius, but there is no deterministic cascade/blast-radius or circuit-breaker control for multi-step/multi-agent failure propagation.",
    },
    ASI09: {
      bucket: "na",
      checks: [],
      rationale:
        "Exploiting the human's trust in the agent is a social/technical vector outside kit's local, static, zero-LLM scope; kit governs machine actions, not human decisions.",
    },
    ASI10: {
      bucket: "gap",
      checks: ["kit audit", "kit identity", "kit panic"],
      rationale:
        "kit gives attribution and response for a compromised agent — signed identity + hash-chained audit + panic (rotate identity, emit signed revocation) — but has no deterministic rogue-agent DETECTION; containment is post-hoc, not prevention.",
    },
  },
};
