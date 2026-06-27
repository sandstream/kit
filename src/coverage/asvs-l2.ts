/**
 * Vendored, pinned subset of the OWASP Application Security Verification
 * Standard (ASVS), Level 2.
 *
 * HONESTY NOTE (this is the product): this is NOT the full ASVS. The full
 * standard has roughly 280 controls across 14 chapters; the vast majority are
 * application-runtime, design-process, or human-review concerns that a local,
 * zero-LLM, deterministic tool like kit cannot observe. Vendoring the whole
 * list and silently marking 90% of it "manual" would be dishonest theatre.
 *
 * So this file deliberately vendors ONLY the controls kit can actually speak
 * to - controls where kit either (a) runs a deterministic check that produces
 * evidence, (b) is squarely in scope but has no check yet (an honest GAP), or
 * (c) is in scope but inherently needs a human (MANUAL). A small number of
 * adjacent controls are kept as N/A with an explicit reason so the boundary of
 * kit's reach is visible rather than hidden.
 *
 * This is an EVIDENCE source, not a compliance attestation. It exists to feed a
 * GRC tool (Vanta, Drata, ...), not to replace one. See src/coverage/coverage.ts
 * for the check -> control mapping and the bucketing.
 *
 * Source: OWASP Application Security Verification Standard 4.0.3 (pinned).
 *   - https://owasp.org/www-project-application-security-verification-standard/
 *   - https://github.com/OWASP/ASVS/tree/v4.0.3
 * Control `text` below is a SHORT paraphrase for orientation, not the verbatim
 * normative requirement; consult the pinned source for the authoritative wording.
 */

/** Pinned ASVS version. Bump deliberately and re-review every mapping. */
export const ASVS_VERSION = "4.0.3";

/** Human-readable name of the pinned standard. */
export const ASVS_SOURCE = "OWASP Application Security Verification Standard 4.0.3";

/** Canonical, version-pinned source URL for the vendored subset. */
export const ASVS_SOURCE_URL = "https://github.com/OWASP/ASVS/tree/v4.0.3";

export interface AsvsRequirement {
  /** ASVS requirement id, e.g. "V2.10.4". */
  id: string;
  /** Chapter label the requirement belongs to, e.g. "V2 Authentication". */
  section: string;
  /** Short paraphrase of the requirement (orientation only, not normative). */
  text: string;
  /** ASVS level at which the requirement applies (subset is bounded to <= L2). */
  level: 1 | 2;
  /** Related CWE id where the relationship is natural; omitted when forced. */
  cwe?: number;
}

/**
 * The curated subset. Kept small, ordered by ASVS id within section. Every entry
 * here MUST have a mapping in coverage.ts (the well-formedness test enforces it),
 * so the two files cannot drift.
 */
export const ASVS_L2_SUBSET: readonly AsvsRequirement[] = [
  // V1 Architecture, Design and Threat Modeling - process controls; included to
  // make explicit that kit does NOT pretend to verify design process.
  {
    id: "V1.1.2",
    section: "V1 Architecture, Design and Threat Modeling",
    text: "Threat modeling is applied for every design change to identify threats and countermeasures.",
    level: 2,
  },

  // V2 Authentication
  {
    id: "V2.10.4",
    section: "V2 Authentication",
    text: "Service-account and integration secrets are not stored in clear text in source code or configuration.",
    level: 2,
    cwe: 798,
  },

  // V6 Stored Cryptography
  {
    id: "V6.4.1",
    section: "V6 Stored Cryptography",
    text: "A secrets-management solution (e.g. a key vault) is used to create, store, and control access to secrets.",
    level: 2,
    cwe: 522,
  },
  {
    id: "V6.4.2",
    section: "V6 Stored Cryptography",
    text: "Key material is not exposed to the application; an isolated security module performs key operations.",
    level: 2,
    cwe: 320,
  },

  // V7 Error Handling and Logging
  {
    id: "V7.1.1",
    section: "V7 Error Handling and Logging",
    text: "The application does not log credentials, session tokens, or payment details.",
    level: 2,
    cwe: 532,
  },
  {
    id: "V7.1.2",
    section: "V7 Error Handling and Logging",
    text: "The application does not log other sensitive data (as defined by applicable privacy law) unless necessary.",
    level: 2,
    cwe: 532,
  },
  {
    id: "V7.3.1",
    section: "V7 Error Handling and Logging",
    text: "Logging components encode data appropriately to prevent log injection.",
    level: 2,
    cwe: 117,
  },

  // V10 Malicious Code
  {
    id: "V10.3.2",
    section: "V10 Malicious Code",
    text: "Integrity protections are used; the application does not load or execute code from untrusted sources.",
    level: 2,
    cwe: 829,
  },

  // V14 Configuration
  {
    id: "V14.1.1",
    section: "V14 Configuration",
    text: "Build and deployment processes are secure and repeatable (e.g. CI/CD automation, hardened pipelines).",
    level: 2,
    cwe: 1059,
  },
  {
    id: "V14.1.5",
    section: "V14 Configuration",
    text: "Authorized administrators can verify the integrity of security-relevant configuration to detect tampering.",
    level: 2,
    cwe: 345,
  },
  {
    id: "V14.2.1",
    section: "V14 Configuration",
    text: "All components are up to date, ideally checked by a dependency checker during build.",
    level: 1,
    cwe: 1104,
  },
  {
    id: "V14.2.4",
    section: "V14 Configuration",
    text: "Third-party components come from pre-defined, trusted, and continually maintained repositories.",
    level: 2,
    cwe: 829,
  },
  {
    id: "V14.4.1",
    section: "V14 Configuration",
    text: "Every HTTP response sets a Content-Type header with a safe character set.",
    level: 1,
    cwe: 116,
  },

  // V8 Data Protection
  {
    id: "V8.2.2",
    section: "V8 Data Protection",
    text: "Sensitive data is not stored in client-side browser storage (localStorage, sessionStorage).",
    level: 2,
    cwe: 922,
  },
] as const;
