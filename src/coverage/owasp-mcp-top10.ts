/**
 * Vendored, pinned OWASP MCP Top 10 (2025) as a kit coverage evidence map. Same
 * honesty rule as the ASVS / LLM-Top10 maps: kit maps ONLY what its deterministic,
 * local, zero-LLM checks can actually speak to, and buckets each risk honestly
 * (auto / gap / manual / na). This is an EVIDENCE source, not a compliance
 * attestation.
 *
 * Control ids/titles were confirmed against multiple secondary indexes (owasp.org
 * first-party fetch returned HTTP 403 in this environment, as with the LLM-Top10
 * map). MCP06's title varies across sources ("Intent Flow Subversion" vs "Prompt
 * Injection via Contextual Payloads"); the OWASP designation used here is the
 * former. See the `caveat`.
 *
 * Source: OWASP MCP Top 10 (2025), OWASP Foundation (project lead V. Verma Sehgal).
 *   - https://owasp.org/www-project-mcp-top-10/
 */
import type { StandardDescriptor } from "./standard.js";

const SECTION = "OWASP MCP Top 10 (2025)";

export const OWASP_MCP_TOP10: StandardDescriptor = {
  key: "mcp-top10",
  label: "OWASP MCP Top 10",
  version: "2025",
  source: "OWASP MCP Top 10 (2025), OWASP Foundation",
  sourceUrl: "https://owasp.org/www-project-mcp-top-10/",
  unit: "risk",
  caveat:
    "Titles confirmed via secondary indexes (owasp.org first-party fetch was HTTP-403 blocked), not per-page verified; MCP06's title varies by source (Intent Flow Subversion / Prompt Injection via Contextual Payloads).",
  requirements: [
    { id: "MCP01:2025", section: SECTION, text: "Token Mismanagement & Secret Exposure" },
    { id: "MCP02:2025", section: SECTION, text: "Privilege Escalation via Scope Creep" },
    { id: "MCP03:2025", section: SECTION, text: "Tool Poisoning" },
    { id: "MCP04:2025", section: SECTION, text: "Software Supply Chain Attacks & Dependency Tampering" },
    { id: "MCP05:2025", section: SECTION, text: "Command Injection & Execution" },
    { id: "MCP06:2025", section: SECTION, text: "Intent Flow Subversion" },
    { id: "MCP07:2025", section: SECTION, text: "Insufficient Authentication & Authorization" },
    { id: "MCP08:2025", section: SECTION, text: "Lack of Audit and Telemetry" },
    { id: "MCP09:2025", section: SECTION, text: "Shadow MCP Servers" },
    { id: "MCP10:2025", section: SECTION, text: "Context Injection & Over-Sharing" },
  ],
  mapping: {
    "MCP01:2025": {
      bucket: "auto",
      checks: ["secrets scan", "gate-env", "scan-transcripts", "kit secrets"],
      rationale:
        "kit keeps credentials in the vault and out of the agent loop, blocks secret writes to .env (gate-env), and scans transcripts/caches for leaked tokens — directly the token-mismanagement/secret-exposure risk.",
    },
    "MCP02:2025": {
      bucket: "auto",
      checks: ["gate-egress", "gate-fs", "signed scope", "kit profile", "broker enforce"],
      rationale:
        "The signed [scope] is least-privilege by construction: the exec-broker denies off-scope egress/fs/secret access, profile reconciliation flags declared-vs-discovered drift, and observe→enforce graduates enforcement — scope creep is exactly what this gates.",
    },
    "MCP03:2025": {
      bucket: "auto",
      checks: ["kit triage mcp"],
      rationale:
        "kit triage mcp statically flags tool-metadata poisoning (malicious instructions hidden in tool descriptions/parameter schemas/return values) and rug-pull drift — the tool-poisoning vector head-on.",
    },
    "MCP04:2025": {
      bucket: "auto",
      checks: ["supply-chain", "kit slopsquat", "kit triage mcp", "pinned versions", "sbom"],
      rationale:
        "kit gates un-triaged installs, scores slopsquat/typosquat risk (incl. fake 'official' connectors), triages MCP packages, verifies pinned/locked deps, and inventories the agent toolchain in the SBOM.",
    },
    "MCP05:2025": {
      bucket: "auto",
      checks: ["gate-bash", "agent-audit"],
      rationale:
        "Narrow slice: kit denies dangerous/un-triaged command execution the agent attempts (gate-bash, deny-by-default) at the tool boundary. Command-injection flaws inside an MCP server's own code are outside kit's local static reach.",
    },
    "MCP06:2025": {
      bucket: "auto",
      checks: ["kit triage mcp", "memory injection", "R7"],
      rationale:
        "kit statically flags injected instructions in MCP tool descriptions and quarantines high-confidence injection on its own recall/inject path (R7). It does not claim to stop intent subversion inside the model.",
    },
    "MCP07:2025": {
      bucket: "gap",
      checks: [],
      rationale:
        "kit authorizes the AGENT's use of MCP tools via the signed scope (client-side), and triage can surface a server missing auth, but kit does not run the MCP server and has no enforcement of server-side client authentication/authorization.",
    },
    "MCP08:2025": {
      bucket: "auto",
      checks: ["kit audit", "broker observe"],
      rationale:
        "kit records tool-call decisions to a tamper-evident, hash-chained audit log (incl. observe-mode would-deny events) — directly the audit/telemetry the risk says is missing; it is fail-closed (a check that can't record fails).",
    },
    "MCP09:2025": {
      bucket: "auto",
      checks: ["kit profile", "sbom", "kit triage mcp"],
      rationale:
        "kit profile discovery + toolchain SBOM inventory the MCP servers actually present and reconcile them against the declared set — an undeclared ('shadow') MCP server surfaces as declared-vs-discovered drift.",
    },
    "MCP10:2025": {
      bucket: "gap",
      checks: ["R7", "scan-transcripts"],
      rationale:
        "kit sanitizes its OWN recall/inject path and keeps secrets out of context, but has no check for cross-session context over-sharing or persistence inside the MCP layer itself.",
    },
  },
};
