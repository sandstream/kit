/**
 * Rule citations for kit's deterministic checks.
 *
 * Each finding can carry a `RuleRef` pointing at the rule it enforces (CWE,
 * OWASP Top 10, or a kit-native rule). This is a LOCAL, deterministic lookup
 * with no network access. kit only maps the checks it actually implements, so
 * the catalog stays bounded to the number of checks, not the full CWE/OWASP
 * corpus. A check without a clear, defensible anchor carries no rule (the field
 * is optional; a forced weak mapping is worse than none).
 *
 * Maintenance: this map is co-located with the checks it describes. When you add
 * a security check, add its mapping here in the same change. Framework IDs (CWE,
 * OWASP Top 10) are low-churn and pinned by ID, so the catalog does not rot.
 */

export interface RuleRef {
  /** Short display id, e.g. "CWE-798" or "OWASP-A06". */
  id: string;
  source: "cwe" | "owasp" | "asvs" | "kit";
  /** Canonical reference URL. */
  ref: string;
  title: string;
}

const cwe = (n: number, title: string): RuleRef => ({
  id: `CWE-${n}`,
  source: "cwe",
  ref: `https://cwe.mitre.org/data/definitions/${n}.html`,
  title,
});

const owasp = (num: string, slug: string, title: string): RuleRef => ({
  id: `OWASP-${num}`,
  source: "owasp",
  ref: `https://owasp.org/Top10/${slug}/`,
  title,
});

// kit-native rule: a self-hardening lesson kit enforces on its own source that
// has no single defensible CWE/OWASP anchor. The id is the self-audit rule id;
// the ref points at the self-audit docs section for that class.
const kit = (id: string, title: string): RuleRef => ({
  id: `kit:${id}`,
  source: "kit",
  ref: `https://github.com/sandstream/kit/blob/master/docs/self-audit.md#${id.toLowerCase()}`,
  title,
});

/**
 * Security check `name` (from check-security.ts `SecurityCheckResult.name`) to
 * the rule it enforces. Intentionally unmapped (no single defensible anchor):
 * "license check", "semgrep SAST" (an engine; its own findings carry their own
 * citations), "requirements.txt" (presence, not a weakness).
 */
export const SECURITY_RULES: Record<string, RuleRef> = {
  ".env gitignored": cwe(
    538,
    "Insertion of Sensitive Information into Externally-Accessible File or Directory",
  ),
  "secrets scan": cwe(798, "Use of Hard-coded Credentials"),
  "npm audit": owasp(
    "A06",
    "A06_2021-Vulnerable_and_Outdated_Components",
    "A06:2021 Vulnerable and Outdated Components",
  ),
  "pip-audit": owasp(
    "A06",
    "A06_2021-Vulnerable_and_Outdated_Components",
    "A06:2021 Vulnerable and Outdated Components",
  ),
  "trivy container scan": owasp(
    "A06",
    "A06_2021-Vulnerable_and_Outdated_Components",
    "A06:2021 Vulnerable and Outdated Components",
  ),
  "pinned versions": cwe(1104, "Use of Unmaintained Third Party Components"),
  "package-lock.json": owasp(
    "A08",
    "A08_2021-Software_and_Data_Integrity_Failures",
    "A08:2021 Software and Data Integrity Failures",
  ),
  "socket scan": owasp(
    "A08",
    "A08_2021-Software_and_Data_Integrity_Failures",
    "A08:2021 Software and Data Integrity Failures",
  ),
  Ollama: cwe(668, "Exposure of Resource to Wrong Sphere"),
  "Remote API": cwe(668, "Exposure of Resource to Wrong Sphere"),
};

/** Look up the rule a security check enforces, or undefined if unmapped. */
export function ruleForCheck(name: string): RuleRef | undefined {
  return SECURITY_RULES[name];
}

/**
 * Citations for the `kit self-audit` rules, keyed by self-audit rule id. Hybrid
 * kit:/CWE per open-decision #3: classes with a clean, defensible framework anchor
 * map to a CWE; the rest are kit-native self-hardening lessons.
 *   R3  -> CWE-732 (incorrect permission assignment for critical resource)
 *   R6  -> CWE-829 (inclusion of functionality from untrusted control sphere)
 *   R7  -> CWE-116 (improper encoding/escaping of output)
 *   R9  -> CWE-345 (insufficient verification of data authenticity — broken chain)
 *   R10 -> CWE-426 (untrusted search path — bare command via PATH)
 */
export const SELF_AUDIT_RULES: Record<string, RuleRef> = {
  "R1-fail-open-ci": kit("R1-fail-open-ci", "Fail-open CI step swallows failures"),
  "R1b-nan-fresh": kit("R1b-nan-fresh", "NaN timestamp compared as fresh (fail-open)"),
  "R2-secret-argv": kit("R2-secret-argv", "Secret leaked via raw exec error message"),
  "R3-state-perms": cwe(732, "Incorrect Permission Assignment for Critical Resource"),
  "R4-validate-before-use": kit("R4-validate-before-use", "Sink invoked before its validator"),
  "R5-env-trust": kit("R5-env-trust", "Env var relaxes a check (trust inventory)"),
  "R6-dynamic-import": cwe(829, "Inclusion of Functionality from Untrusted Control Sphere"),
  "R7-output-escaping": cwe(116, "Improper Encoding or Escaping of Output"),
  "R8-readonly-guard": kit("R8-readonly-guard", "Mutating MCP tool lacks read-only guard"),
  "R9-unkeyed-anchor": cwe(345, "Insufficient Verification of Data Authenticity"),
  "R10-toolchain-pin": cwe(426, "Untrusted Search Path"),
  "R11-script-paths": kit("R11-script-paths", "CI references a missing/renamed script"),
  "R12-dup-source": kit("R12-dup-source", "Cloud-sync duplicate-source conflict copy in tree"),
};

/** Look up the citation for a self-audit rule id, or undefined if unmapped. */
export function ruleForSelfAudit(id: string): RuleRef | undefined {
  return SELF_AUDIT_RULES[id];
}
