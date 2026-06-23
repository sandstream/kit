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
