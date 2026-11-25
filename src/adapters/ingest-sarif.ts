/**
 * SARIF 2.1.0 reader for `kit ingest`: one SARIF result becomes one `SecurityCheckResult`.
 * Pure (string in → findings out); split from `ingest.ts`, which keeps the strict reader.
 */
import type { SecurityCheckResult } from "../check-security.js";
import type { RuleRef } from "../rules/catalog.js";

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
interface SarifLocation {
  physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } };
}
interface SarifResult {
  ruleId?: string;
  /** SARIF 2.1.0 `kind`; absent means `fail`. */
  kind?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
  properties?: { "security-severity"?: string };
}
export interface SarifRun {
  properties?: Record<string, unknown>;
  tool?: { driver?: { name?: string; rules?: SarifRule[] } };
  results?: SarifResult[];
}
export interface SarifLog {
  runs?: SarifRun[];
}

function sarifLocation(res: SarifResult): string {
  const { artifactLocation, region } = res.locations?.[0]?.physicalLocation ?? {};
  const uri = artifactLocation?.uri;
  return uri ? ` (${uri}${region?.startLine ? `:${region.startLine}` : ""})` : "";
}

function sarifFinding(
  tool: string,
  res: SarifResult,
  rulesById: Map<string, SarifRule>,
): SecurityCheckResult {
  const ruleId = res.ruleId ?? "(rule)";
  const rule = rulesById.get(ruleId);
  const severity =
    cvssToSeverity(
      res.properties?.["security-severity"] ?? rule?.properties?.["security-severity"],
    ) ?? levelToSeverity(res.level ?? rule?.defaultConfiguration?.level);
  return {
    category: "exposure",
    name: `${tool}: ${ruleId}`,
    status: "fail",
    detail: `${res.message?.text ?? ruleId}${sarifLocation(res)}`,
    severity,
    rule: cweRuleFromTags(rule?.properties?.tags),
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
 * coverage rows this way. `open` (Nuclei marks every result open), `review`, `fail` and an absent kind
 * stay findings.
 */
const SARIF_NOT_FAILED = new Set(["pass", "notApplicable", "informational"]);

export function sarifFindings(log: SarifLog): SecurityCheckResult[] {
  const out: SecurityCheckResult[] = [];
  for (const run of log.runs ?? []) {
    const tool = run.tool?.driver?.name ?? "sarif";
    const rulesById = new Map<string, SarifRule>();
    for (const r of run.tool?.driver?.rules ?? []) if (r.id) rulesById.set(r.id, r);
    for (const res of run.results ?? []) {
      if (!SARIF_NOT_FAILED.has(String(res.kind))) out.push(sarifFinding(tool, res, rulesById));
    }
  }
  return out;
}
