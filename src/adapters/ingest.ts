/**
 * Scanner-output ingestion adapters: one parser per *format*, not per tool.
 *
 * SARIF 2.1.0 is emitted by semgrep, CodeQL, Trivy, Grype, …; OSV-scanner JSON by
 * osv-scanner and others. Normalizing the format (not each tool) lets kit ingest
 * any SARIF/OSV-emitting scanner into its own `SecurityCheckResult` shape — so the
 * finding ledger, citations, and severity ranking work uniformly across engines.
 *
 * Pure (string in → findings out); no I/O, so it's fully fixture-tested.
 */
import type { SecurityCheckResult } from "../check-security.js";
import type { RuleRef } from "../rules/catalog.js";

type Severity = NonNullable<SecurityCheckResult["severity"]>;

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
  properties?: { tags?: string[]; "security-severity"?: string };
}
interface SarifLocation {
  physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } };
}
interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
  properties?: { "security-severity"?: string };
}
interface SarifRun {
  tool?: { driver?: { name?: string; rules?: SarifRule[] } };
  results?: SarifResult[];
}
interface SarifLog {
  runs?: SarifRun[];
}

export function parseSarif(json: string): SecurityCheckResult[] {
  let log: SarifLog;
  try {
    log = JSON.parse(json) as SarifLog;
  } catch {
    return [];
  }
  const out: SecurityCheckResult[] = [];
  for (const run of log.runs ?? []) {
    const tool = run.tool?.driver?.name ?? "sarif";
    const rulesById = new Map<string, SarifRule>();
    for (const r of run.tool?.driver?.rules ?? []) if (r.id) rulesById.set(r.id, r);
    for (const res of run.results ?? []) {
      const ruleId = res.ruleId ?? "(rule)";
      const rule = rulesById.get(ruleId);
      const severity =
        cvssToSeverity(
          res.properties?.["security-severity"] ?? rule?.properties?.["security-severity"],
        ) ?? levelToSeverity(res.level);
      const loc = res.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri;
      const line = loc?.region?.startLine;
      const where = uri ? ` (${uri}${line ? `:${line}` : ""})` : "";
      out.push({
        category: "exposure",
        name: `${tool}: ${ruleId}`,
        status: "fail",
        detail: `${res.message?.text ?? ruleId}${where}`,
        severity,
        rule: cweRuleFromTags(rule?.properties?.tags),
      });
    }
  }
  return out;
}

// ---- OSV-scanner JSON (minimal shape) ----
interface OsvVuln {
  id?: string;
  summary?: string;
  database_specific?: { severity?: string };
}
interface OsvPackage {
  package?: { name?: string; ecosystem?: string; version?: string };
  vulnerabilities?: OsvVuln[];
}
interface OsvResult {
  packages?: OsvPackage[];
}
interface OsvLog {
  results?: OsvResult[];
}

const OSV_RULE: RuleRef = {
  id: "OWASP-A06",
  source: "owasp",
  ref: "https://owasp.org/Top10/A06_2021-Vulnerable_and_Outdated_Components/",
  title: "Vulnerable and Outdated Components",
};

function osvSeverity(v: OsvVuln): Severity {
  switch ((v.database_specific?.severity ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      // A reported vuln with an unknown label is still worth flagging high.
      return "high";
  }
}

export function parseOsv(json: string): SecurityCheckResult[] {
  let log: OsvLog;
  try {
    log = JSON.parse(json) as OsvLog;
  } catch {
    return [];
  }
  const out: SecurityCheckResult[] = [];
  for (const r of log.results ?? []) {
    for (const p of r.packages ?? []) {
      const name = p.package?.name ?? "(package)";
      const ver = p.package?.version ? `@${p.package.version}` : "";
      for (const v of p.vulnerabilities ?? []) {
        out.push({
          category: "dependency",
          name: `${name}${ver}: ${v.id ?? "vuln"}`,
          status: "fail",
          detail: v.summary ?? v.id ?? "known vulnerability",
          severity: osvSeverity(v),
          rule: OSV_RULE,
        });
      }
    }
  }
  return out;
}

export type IngestFormat = "sarif" | "osv";

/** Dispatch to the right parser. Unknown format → []. */
export function ingest(format: IngestFormat, json: string): SecurityCheckResult[] {
  return format === "sarif" ? parseSarif(json) : format === "osv" ? parseOsv(json) : [];
}
