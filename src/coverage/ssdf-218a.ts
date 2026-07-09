/**
 * Vendored, pinned NIST SSDF (SP 800-218 v1.1) practices as a kit coverage evidence
 * map — the subset kit's deterministic checks can speak to. SP 800-218A ("Secure
 * Software Development Practices for Generative AI and Dual-Use Foundation Models",
 * Jul 2024) is a Community PROFILE that augments 800-218 *without* a separate
 * numbering scheme, so kit maps at the 800-218 practice level that 218A profiles.
 *
 * Same honesty rule as the ASVS subset: only practices kit can actually observe are
 * vendored; the rest (org/process/human) are omitted rather than mass-marked manual.
 * EVIDENCE source, not a compliance attestation.
 *
 * Practice ids/names confirmed against csrc.nist.gov via search index (first-party
 * fetch was egress-blocked). Group ids (PO/PS/PW/RV) and PW.7/PW.8 were live-
 * confirmed; the rest are from the stable published framework. kit does NOT enumerate
 * 218A's specific AI task augmentations (those need the 218A appendix, not fetched).
 *
 * Sources:
 *   - SP 800-218 v1.1: https://csrc.nist.gov/pubs/sp/800/218/final
 *   - SP 800-218A: https://csrc.nist.gov/pubs/sp/800/218/a/final
 */
import type { StandardDescriptor } from "./standard.js";

const PO = "PO — Prepare the Organization";
const PS = "PS — Protect the Software";
const PW = "PW — Produce Well-Secured Software";
const RV = "RV — Respond to Vulnerabilities";

export const SSDF_218A: StandardDescriptor = {
  key: "ssdf",
  label: "NIST SSDF",
  version: "SP 800-218 v1.1 (profiled by 218A)",
  source: "NIST SP 800-218 v1.1 Secure Software Development Framework, with the SP 800-218A GenAI Community Profile",
  sourceUrl: "https://csrc.nist.gov/pubs/sp/800/218/final",
  unit: "practice",
  caveat:
    "Mapped at the 800-218 practice level that SP 800-218A (GenAI profile, Jul 2024) augments; kit does not enumerate 218A's specific AI task IDs. Practice text confirmed via search index, not first-party fetch (egress-blocked).",
  requirements: [
    { id: "PO.3", section: PO, text: "Implement Supporting Toolchains" },
    { id: "PO.4", section: PO, text: "Define and Use Criteria for Software Security Checks" },
    { id: "PS.1", section: PS, text: "Protect All Forms of Code from Unauthorized Access and Tampering" },
    { id: "PS.2", section: PS, text: "Provide a Mechanism for Verifying Software Release Integrity" },
    { id: "PW.4", section: PW, text: "Reuse Existing, Well-Secured Software When Feasible" },
    { id: "PW.6", section: PW, text: "Configure the Compilation, Interpreter, and Build Processes" },
    { id: "PW.7", section: PW, text: "Review and/or Analyze Human-Readable Code" },
    { id: "PW.8", section: PW, text: "Test Executable Code" },
    { id: "PW.9", section: PW, text: "Configure Software to Have Secure Settings by Default" },
    { id: "RV.1", section: RV, text: "Identify and Confirm Vulnerabilities on an Ongoing Basis" },
    { id: "RV.2", section: RV, text: "Assess, Prioritize, and Remediate Vulnerabilities" },
  ],
  mapping: {
    "PO.3": {
      bucket: "auto",
      checks: ["kit check", "provision"],
      rationale:
        "kit IS a deterministic security toolchain — it provisions and runs the checks/gates automatically rather than relying on manual tooling.",
    },
    "PO.4": {
      bucket: "auto",
      checks: ["kit check", "standards", "baseline"],
      rationale:
        "kit defines and enforces explicit pass/fail security criteria (check / standards / coverage) with a committed baseline for net-new gating.",
    },
    "PS.1": {
      bucket: "auto",
      checks: ["secrets scan", ".env gitignored", "gate-env"],
      rationale:
        "Partial: kit blocks plaintext secrets in code/config and secret writes to .env, reducing unauthorized exposure of code/credentials; it does not manage repository access control.",
    },
    "PS.2": {
      bucket: "auto",
      checks: ["attestation", "cosign", "R9"],
      rationale:
        "kit verifies release/artifact signatures (Sigstore/cosign) and keeps its own audit log tamper-evident (HMAC anchor), giving a mechanism to verify integrity.",
    },
    "PW.4": {
      bucket: "auto",
      checks: ["supply-chain", "kit slopsquat", "kit triage mcp", "security policy"],
      rationale:
        "kit triages third-party components (install-gate, slopsquat, MCP triage) and can enforce a trusted-source allowlist before reuse.",
    },
    "PW.6": {
      bucket: "auto",
      checks: ["gha-audit"],
      rationale:
        "Partial: kit lints CI/build workflows for unpinned actions and unsafe patterns; it does not verify full build reproducibility.",
    },
    "PW.7": {
      bucket: "auto",
      checks: ["standards", "self-audit"],
      rationale:
        "kit statically analyzes human-readable code (standards: complexity/duplication/linters; self-audit bug-classes) — a deterministic slice of code review.",
    },
    "PW.8": {
      bucket: "na",
      checks: [],
      rationale:
        "Executing and testing the target's built code (unit/DAST/fuzz) is a runtime activity; kit is local, static, and zero-egress.",
    },
    "PW.9": {
      bucket: "auto",
      checks: ["kit setup", "gate-bash", "gate-env"],
      rationale:
        "kit ships secure-by-default: setup installs the enforcement gates, and the warn→enforce ramp keeps defaults safe.",
    },
    "RV.1": {
      bucket: "auto",
      checks: ["npm audit", "trivy container scan", "supply-chain", "sbom"],
      rationale:
        "kit runs dependency/vuln scanners (npm/pip audit, trivy), merges external scanners into one verdict, and can emit an SBOM of the resolved tree.",
    },
    "RV.2": {
      bucket: "gap",
      checks: [],
      rationale:
        "kit surfaces severity and a unified verdict, but deterministic remediation/rotation TRACKING (a finding isn't 'handled' until fixed) is a planned follow-up, not yet a check.",
    },
  },
};
