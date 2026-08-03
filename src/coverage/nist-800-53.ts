/**
 * Vendored, pinned NIST SP 800-53 Rev. 5 as a kit coverage evidence map — the
 * accreditation-oriented slice of the regulated-edition track (kit issue #349).
 *
 * Structure note: 800-53 Rev. 5 defines ~1000 controls across 20 FAMILIES. Mapping
 * every control would be neither honest nor useful from a local CLI, so this maps at
 * the **control-family** level: "which families can kit's deterministic, local,
 * zero-LLM checks speak to at all?" Families that are physical, personnel, or
 * organizational by nature are bucketed `na` — kit's charter deliberately does not
 * cover them, and claiming otherwise would be a false green.
 *
 * This is an evidence map for an assessor to ingest, NOT an attestation and NOT an
 * ATO package. Family-level coverage never implies every control in that family is
 * satisfied — it means kit produces deterministic evidence relevant to that family.
 *
 * Source: NIST SP 800-53 Rev. 5 (incl. Rev 5.1.1 patch release).
 *   - https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final
 */
import type { StandardDescriptor } from "./standard.js";

const S_TECH = "Technical & operational families";
const S_ORG = "Organizational & physical families";

export const NIST_800_53: StandardDescriptor = {
  key: "nist-800-53",
  label: "NIST SP 800-53 Rev. 5 (control families)",
  version: "Rev. 5 (5.1.1)",
  source: "NIST SP 800-53 Rev. 5 — Security and Privacy Controls for Information Systems",
  sourceUrl: "https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final",
  unit: "control family",
  caveat:
    "FAMILY-level evidence map (~1000 individual controls are NOT enumerated). A family bucketed `auto` means kit emits deterministic evidence relevant to that family — never that every control in it is satisfied. Physical/personnel/organizational families are `na` by charter. This is an evidence map, not an attestation, and not an ATO package.",
  requirements: [
    { id: "AC", section: S_TECH, text: "Access Control" },
    { id: "AU", section: S_TECH, text: "Audit and Accountability" },
    { id: "CA", section: S_TECH, text: "Assessment, Authorization, and Monitoring" },
    { id: "CM", section: S_TECH, text: "Configuration Management" },
    { id: "IA", section: S_TECH, text: "Identification and Authentication" },
    { id: "IR", section: S_TECH, text: "Incident Response" },
    { id: "PT", section: S_TECH, text: "PII Processing and Transparency" },
    { id: "RA", section: S_TECH, text: "Risk Assessment" },
    { id: "SA", section: S_TECH, text: "System and Services Acquisition" },
    { id: "SC", section: S_TECH, text: "System and Communications Protection" },
    { id: "SI", section: S_TECH, text: "System and Information Integrity" },
    { id: "SR", section: S_TECH, text: "Supply Chain Risk Management" },
    { id: "AT", section: S_ORG, text: "Awareness and Training" },
    { id: "CP", section: S_ORG, text: "Contingency Planning" },
    { id: "MA", section: S_ORG, text: "Maintenance" },
    { id: "MP", section: S_ORG, text: "Media Protection" },
    { id: "PE", section: S_ORG, text: "Physical and Environmental Protection" },
    { id: "PL", section: S_ORG, text: "Planning" },
    { id: "PM", section: S_ORG, text: "Program Management" },
    { id: "PS", section: S_ORG, text: "Personnel Security" },
  ],
  mapping: {
    AC: {
      bucket: "auto",
      checks: ["signed scope", "gate-egress", "gate-fs", "gate-bash", "kit auth", "security policy"],
      rationale:
        "kit enforces least privilege at the tool boundary from a signed scope/RoE: the exec-broker's PreToolUse gates deny egress and filesystem access outside the declared scope (fail-closed — no verified scope grants nothing), destructive secret operations require an explicit elevation (TOTP), and RBAC comes from the signed policy document. Scope for the FAMILY: this is agent/tool-boundary access control on the developer host, not your production application's user-facing authorization.",
    },
    AU: {
      bucket: "auto",
      checks: ["kit audit", "attestation", "fail-closed", "kit identity"],
      rationale:
        "Every governed operation appends to a hash-chained, tamper-evident local audit log bound to an attributable Ed25519 identity; `kit audit verify` detects rewriting/truncation, `kit audit anchor` seals with a machine-local HMAC anchor, and `kit audit export` hands the record to an external system. Destructive paths fail CLOSED when the audit append fails, so an unlogged action is refused rather than silently performed. Honest limit already documented in kit: the anchor is not tamper-proof against a same-UID principal who can read the key.",
    },
    CA: {
      bucket: "auto",
      checks: ["kit check", "self-audit", "kit coverage", "standards", "baseline"],
      rationale:
        "kit is a CONTINUOUS deterministic assessment: `kit check`/`kit review` emit one verdict per run across tools/secrets/hooks/security/tests/standards/ADRs, `kit self-audit` checks kit's own source against its bug classes, and `kit coverage` emits this and the other evidence maps as machine-readable output for an assessor. The authorization decision (ATO) and the assessor's judgement remain human — kit supplies evidence for CA, it does not grant an authorization.",
    },
    CM: {
      bucket: "auto",
      checks: ["kit profile", "baseline", "standards", "kit check", "gha-audit"],
      rationale:
        "The traveling profile declares the sanctioned configuration (skills/MCP/workflows/plugins/vault/gates/scope), `kit profile check` reports declared-vs-discovered DRIFT deterministically, the baseline freezes accepted findings so only net-new ones gate, and the config schema rejects unknown sections. `kit gha-audit` covers CI workflow hardening. Change control itself (approvals, CCB) is your process; kit proves the configuration state.",
    },
    IA: {
      bucket: "auto",
      checks: ["kit identity", "cosign", "kit auth", "signed scope"],
      rationale:
        "Machine identity is a hardware-rooted Ed25519 key where a backend exists (Secure Enclave / TPM / external command), surfaced honestly by `kit doctor` and NEVER silently downgraded — a file-backed key warns, and `KIT_REQUIRE_HARDWARE_IDENTITY` makes a missing hardware backend fail-closed. Elevation for destructive operations is TOTP-gated. Keyless egress signing (RFC 9421) is NOT shipped: the primitives exist and are tested but no command reaches them, so this family's evidence rests on the identity key and the elevation gate only. Human-user authentication to your systems is out of scope for this family in kit's context.",
    },
    IR: {
      bucket: "manual",
      checks: [],
      rationale:
        "kit ships real incident-RESPONSE capability — `kit panic` rotates the identity and emits a signed revocation, and the audit log is the forensic record — but no deterministic check can verify that an incident-response PROGRAM (roles, playbooks, reporting timelines, exercises) exists and works. That is a human program kit feeds evidence into, so claiming `auto` here would be a false green.",
    },
    PT: {
      bucket: "auto",
      checks: ["secrets scan", "kit check", "kit audit", "scan-transcripts"],
      rationale:
        "For data kit itself holds and moves: the memory write-gate and redaction strip credentials/PII patterns at capture, audit records redact by key name AND value unless `include_secrets` is explicitly opted into, the recall path sanitizes injected content, and `kit check` scans for plaintext secrets/PII leaks. Scope honestly bounded: this covers PII inside kit's own stores and the agent loop — your application's lawful-basis, consent, and data-subject-rights handling is not something kit can verify.",
    },
    RA: {
      bucket: "auto",
      checks: ["kit scan", "npm audit", "trivy container scan", "kit triage", "kit slopsquat"],
      rationale:
        "Vulnerability identification and risk scoring run deterministically: `kit scan` normalizes many external scanners (snyk/trivy/grype/semgrep/osv/socket) into ONE merged verdict and fails closed when a REQUIRED scanner did not actually run (no false green on findings alone), `kit triage` risk-scores a dependency before install, and the slopsquat gate scores typo/hallucination risk. Organizational risk framing and tolerance remain human.",
    },
    SA: {
      bucket: "auto",
      checks: ["kit triage", "sbom", "supply-chain", "kit standards", "kit check"],
      rationale:
        "Acquisition-time controls are kit's home ground: nothing gets installed without triage (the install-gate blocks un-triaged packages at PreToolUse), an SBOM covers both dependencies and the agent toolchain (skills/MCP/plugins), and developer-testing expectations (SA-11-flavored) are gated by `kit standards` + the net-new-test rule. Contract language, supplier agreements, and the SDLC policy itself are organizational.",
    },
    SC: {
      bucket: "auto",
      checks: ["gate-egress", "signed scope", "cosign", "kit doctor", "OS containment"],
      rationale:
        "Boundary protection is enforced, not documented: egress is denied outside the signed scope, and `kit doctor` reports the OS-CONTAINMENT posture beneath the tool boundary (container/seccomp/user-ns plus gVisor/Firecracker fingerprints) — with `[governance.containment] require = true` turning it into a fail-closed gate, and an honest `unknown` off-Linux rather than a false 'not contained'. Disk-encryption posture covers protection at rest. Network/crypto controls in your production infrastructure are separate.",
    },
    SI: {
      bucket: "auto",
      checks: ["kit audit", "kit check", "kit triage", "malware-scan (ClamAV delegate)", "npm audit"],
      rationale:
        "Integrity is verified rather than assumed: the audit chain detects tampering, prompt-injection scanning guards the memory/recall path, `kit triage model` classifies untrusted AI artifacts by format and provenance and — with `--scan-bytes` — delegates a byte-level malware scan to a locally-installed ClamAV where a scan error or missing scanner is surfaced as a GAP, never a silent clean. Flaw remediation is tracked by the audit/patch surface. kit builds no AV engine and no signatures of its own.",
    },
    SR: {
      bucket: "auto",
      checks: ["kit triage", "sbom", "supply-chain", "kit triage mcp", "provision"],
      rationale:
        "The strongest family for kit: pre-install triage for npm/pip/docker/repos/brew, plugin and MCP-server triage (tool-poisoning + rug-pull drift detection against a pin), provenance verification offline (SLSA), a deep supply-chain scan in CI, and an SBOM that includes the AGENT toolchain most SBOMs miss. Provenance of your hardware and upstream vendor practices remain outside a local CLI.",
    },
    AT: {
      bucket: "na",
      checks: [],
      rationale:
        "Security awareness and role-based TRAINING for people. kit writes machine-readable rules for AI agents (`kit agent-config`), which is configuration, not human training — mapping that here would be a category error. Deliberately out of charter.",
    },
    CP: {
      bucket: "na",
      checks: [],
      rationale:
        "Contingency planning, backup strategy, and disaster recovery for the information system. `kit memory backup` protects kit's own local store only; it says nothing about system-level RTO/RPO, alternate sites, or tested recovery. Deliberately out of charter.",
    },
    MA: {
      bucket: "na",
      checks: [],
      rationale:
        "Controlled system maintenance — maintenance personnel, tools, and remote-maintenance sessions. Dependency currency and patching, which people sometimes file here, are covered honestly under SI (flaw remediation) and SR (supply chain) instead of double-counted. Deliberately out of charter.",
    },
    MP: {
      bucket: "na",
      checks: [],
      rationale:
        "Media protection — physical media marking, transport, and sanitization. kit's disk-encryption posture check is mapped under SC (protection at rest) rather than claimed here; a local CLI cannot speak to media handling. Deliberately out of charter.",
    },
    PE: {
      bucket: "na",
      checks: [],
      rationale:
        "Physical and environmental protection (facility access, power, fire, temperature). Nothing a deterministic local CLI can observe or enforce. Deliberately out of charter.",
    },
    PL: {
      bucket: "manual",
      checks: [],
      rationale:
        "Security planning and architecture documentation is a human deliverable. The adjacent thing kit DOES do is enforce a decision once written: `kit adr check` turns an accepted Architecture Decision Record's machine-readable rules into a deterministic gate cited back to the ADR — kit enforces the plan, it never authors or interprets it (prose is never read; that would need an LLM, which is off-charter).",
    },
    PM: {
      bucket: "manual",
      checks: [],
      rationale:
        "Organization-wide information-security program management. kit contributes inputs — signable policy-as-code pulled and enforced offline, plus these coverage evidence maps — but a program (governance bodies, resourcing, org-level plans) exists above a developer-host tool and cannot be deterministically verified from it.",
    },
    PS: {
      bucket: "na",
      checks: [],
      rationale:
        "Personnel security: screening, transfers, sanctions, termination. Entirely an HR/organizational process with no deterministic local signal. Deliberately out of charter.",
    },
  },
};
