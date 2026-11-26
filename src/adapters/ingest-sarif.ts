/**
 * SARIF 2.1.0 reader for `kit ingest`: one SARIF result becomes one `SecurityCheckResult`.
 * Pure (string in → findings out); split from `ingest.ts`, which keeps the strict reader.
 */
import type { SecurityCheckResult } from "../check-security.js";
import type { RuleRef } from "../rules/catalog.js";

import {
  collapseDuplicates,
  sarifFingerprint,
  sarifLocation,
  type SarifFinding,
  type SarifResult,
} from "./ingest-sarif-dedupe.js";

type Severity = NonNullable<SecurityCheckResult["severity"]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** GitHub's SARIF convention: `security-severity` is a CVSS 0–10 string. */
function cvssToSeverity(raw: string | undefined): Severity | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return undefined;
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "medium";
  return "low";
}

/** SARIF `level` fallback when no numeric severity is present. */
function levelToSeverity(level: string | undefined): Severity {
  switch ((level ?? "").toLowerCase()) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low"; // note / none / missing
  }
}

/** A CWE citation if any rule tag looks like `CWE-79` / `cwe-79` / `external/cwe/cwe-89`. */
function cweRuleFromTags(tags: string[] | undefined): RuleRef | undefined {
  for (const t of tags ?? []) {
    const m = /cwe[-/]?(\d+)/i.exec(t);
    if (m) {
      const n = m[1];
      return {
        id: `CWE-${n}`,
        source: "cwe",
        ref: `https://cwe.mitre.org/data/definitions/${n}.html`,
        title: `CWE-${n}`,
      };
    }
  }
  return undefined;
}

// ---- SARIF (minimal shape — only the fields we read) ----
interface SarifRule {
  id?: string;
  defaultConfiguration?: { level?: string };
  properties?: { tags?: string[]; "security-severity"?: string };
}
export interface SarifRun {
  properties?: Record<string, unknown>;
  tool?: { driver?: { name?: string; rules?: SarifRule[] } };
  results?: SarifResult[];
}
export interface SarifLog {
  runs?: SarifRun[];
}

function sarifFinding(
  tool: string,
  res: SarifResult,
  rulesById: Map<string, SarifRule>,
  status: "fail" | "warn",
): SarifFinding {
  const ruleId = res.ruleId ?? "(rule)";
  const rule = rulesById.get(ruleId);
  const severity =
    cvssToSeverity(
      res.properties?.["security-severity"] ?? rule?.properties?.["security-severity"],
    ) ?? levelToSeverity(res.level ?? rule?.defaultConfiguration?.level);
  return {
    category: "exposure",
    name: `${tool}: ${ruleId}`,
    status,
    detail: `${res.message?.text ?? ruleId}${sarifLocation(res)}`,
    severity,
    rule: cweRuleFromTags(rule?.properties?.tags),
    fingerprint: sarifFingerprint(res),
    occurrences: 1,
  };
}

export function parseSarif(json: string): SecurityCheckResult[] {
  let log: unknown;
  try {
    log = JSON.parse(json);
  } catch {
    return [];
  }
  return isRecord(log) ? sarifFindings(log as SarifLog) : [];
}

/**
 * SARIF kinds that say the rule was evaluated and nothing is wrong. A scanner such as Strix writes its
 * coverage rows this way. `open` (Nuclei marks every result open), `fail` and an absent kind stay
 * failures; `review` (a person must still look) is a warning.
 */
const SARIF_NOT_FAILED = new Set(["pass", "notApplicable", "informational"]);

/**
 * SARIF 2.1.0 §3.27.23: a result is suppressed when it carries suppressions and each one is accepted
 * (a missing `status` means accepted). An `underReview` or `rejected` suppression keeps it a finding.
 */
function sarifSuppressed(res: SarifResult): boolean {
  const list: unknown = res.suppressions;
  return (
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((s) => isRecord(s) && (s.status === undefined || s.status === "accepted"))
  );
}

function sarifRules(run: SarifRun): Map<string, SarifRule> {
  const rules = new Map<string, SarifRule>();
  for (const rule of run.tool?.driver?.rules ?? []) if (rule.id) rules.set(rule.id, rule);
  return rules;
}

export function sarifFindings(log: SarifLog, tally = { suppressed: 0 }): SarifFinding[] {
  const out: SarifFinding[] = [];
  for (const run of log.runs ?? []) {
    const tool = run.tool?.driver?.name ?? "sarif";
    const rulesById = sarifRules(run);
    for (const res of run.results ?? []) {
      if (SARIF_NOT_FAILED.has(String(res.kind))) continue;
      if (sarifSuppressed(res)) tally.suppressed++;
      else out.push(sarifFinding(tool, res, rulesById, res.kind === "review" ? "warn" : "fail"));
    }
  }
  return collapseDuplicates(out);
}
