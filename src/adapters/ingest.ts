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
import type { AdvisoryPackage } from "../advisory-import-fact.js";
import type { SecurityCheckResult } from "../check-security.js";
import type { RuleRef } from "../rules/catalog.js";
import { ingestCloudflareAudit } from "./ingest-cloudflare-audit.js";

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
  properties?: Record<string, unknown>;
  tool?: { driver?: { name?: string; rules?: SarifRule[] } };
  results?: SarifResult[];
}
interface SarifLog {
  runs?: SarifRun[];
}

function readSarifLog(json: string): SarifLog | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    // JSON.parse("null")/"42" is valid JSON but not an object; `log.runs` would then throw a
    // TypeError, breaking the documented "malformed input → []" contract. Guard it.
    return parsed === null || typeof parsed !== "object" ? undefined : (parsed as SarifLog);
  } catch {
    return undefined;
  }
}

function sarifLocation(res: SarifResult): string {
  const loc = res.locations?.[0]?.physicalLocation;
  const uri = loc?.artifactLocation?.uri;
  const line = loc?.region?.startLine;
  return uri ? ` (${uri}${line ? `:${line}` : ""})` : "";
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
    ) ?? levelToSeverity(res.level);
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
  const log = readSarifLog(json);
  return log ? sarifFindings(log) : [];
}

function sarifFindings(log: SarifLog): SecurityCheckResult[] {
  const out: SecurityCheckResult[] = [];
  for (const run of log.runs ?? []) {
    const tool = run.tool?.driver?.name ?? "sarif";
    const rulesById = new Map<string, SarifRule>();
    for (const r of run.tool?.driver?.rules ?? []) if (r.id) rulesById.set(r.id, r);
    for (const res of run.results ?? []) out.push(sarifFinding(tool, res, rulesById));
  }
  return out;
}

// ---- OSV-scanner JSON (minimal shape) ----
interface OsvVuln {
  id?: string;
  aliases?: string[];
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
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object") return []; // non-object → [] (contract)
    log = parsed as OsvLog;
  } catch {
    return [];
  }
  return osvFindings(log);
}

function osvFindings(log: OsvLog): SecurityCheckResult[] {
  const out: SecurityCheckResult[] = [];
  for (const r of log.results ?? []) {
    for (const p of r.packages ?? []) out.push(...osvPackageFindings(p));
  }
  return out;
}

/** A dependency finding also says which package it is about, for the import fact beside it. */
type DependencyFinding = SecurityCheckResult & { package?: AdvisoryPackage };

/** The package as the report names it. Absent when the report gives no name. */
function osvPackageRef(p: OsvPackage): { package?: AdvisoryPackage } {
  const { name, ecosystem } = p.package ?? {};
  if (typeof name !== "string") return {};
  return { package: typeof ecosystem === "string" ? { name, ecosystem } : { name } };
}

function osvPackageFindings(p: OsvPackage): DependencyFinding[] {
  const name = p.package?.name ?? "(package)";
  const ver = p.package?.version ? `@${p.package.version}` : "";
  return (p.vulnerabilities ?? []).map((v) => ({
    category: "dependency",
    name: `${name}${ver}: ${v.id ?? "vuln"}`,
    status: "fail",
    detail: v.summary ?? v.id ?? "known vulnerability",
    severity: osvSeverity(v),
    rule: OSV_RULE,
    ...osvAliases(v),
    ...osvPackageRef(p),
  }));
}

const ADVISORY_ALIAS = /^(CVE-\d{4}-\d{4,7}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i;

/**
 * The CVE/GHSA ids OSV lists as the same vulnerability. An npm advisory is keyed by its GHSA id,
 * and the CVE that CISA KEV and EPSS know it by is only in `aliases`. Anything else is dropped.
 */
function osvAliases(v: OsvVuln): { aliases?: string[] } {
  if (!Array.isArray(v.aliases)) return {};
  const ids = v.aliases.filter((a): a is string => typeof a === "string" && ADVISORY_ALIAS.test(a));
  return ids.length > 0 ? { aliases: ids.slice(0, 20).map((a) => a.toUpperCase()) } : {};
}

export type IngestFormat = "sarif" | "osv" | "cloudflare-audit";

/** Dispatch to the right parser. Unknown format → []. Lenient: malformed input → []. */
export function ingest(format: IngestFormat, json: string): SecurityCheckResult[] {
  if (format === "cloudflare-audit") {
    const outcome = ingestStrict(format, json);
    return outcome.ok ? outcome.findings : [];
  }
  return format === "sarif" ? parseSarif(json) : format === "osv" ? parseOsv(json) : [];
}

export type IngestGap = "missing" | "partial" | "malformed" | "unsupported";

export interface DeclaredScannerCoverage {
  id: string;
  status: string;
  findings: number;
  reportGap?: IngestGap;
}

export type IngestOutcome = (
  | {
      ok: true;
      findings: SecurityCheckResult[];
      notes?: string[];
      coverage?: "partial";
      reportGap?: IngestGap;
    }
  | { ok: false; reason: string; reportGap?: IngestGap }
) & { scannerCoverage?: DeclaredScannerCoverage[] };

type FieldCheck = (value: unknown) => boolean;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString: FieldCheck = (value) => typeof value === "string";
const isLine: FieldCheck = (value) =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const arrayOf =
  (check: FieldCheck): FieldCheck =>
  (value) =>
    Array.isArray(value) && value.every(check);

/** Validate consumed fields when present. Scanner extensions remain permitted. */
function fields(checks: Record<string, FieldCheck>): FieldCheck {
  return (value) =>
    isRecord(value) &&
    Object.entries(checks).every(([key, check]) => value[key] === undefined || check(value[key]));
}

const sarifProperties = fields({ "security-severity": isString, tags: arrayOf(isString) });
const sarifNotifications = arrayOf(fields({ level: isString }));
const sarifInvocation: FieldCheck = (value) =>
  isRecord(value) &&
  typeof value.executionSuccessful === "boolean" &&
  fields({
    toolExecutionNotifications: sarifNotifications,
    toolConfigurationNotifications: sarifNotifications,
  })(value);

const sarifResult = fields({
  ruleId: isString,
  level: isString,
  message: fields({ text: isString }),
  properties: sarifProperties,
  locations: arrayOf(
    fields({
      physicalLocation: fields({
        artifactLocation: fields({ uri: isString }),
        region: fields({ startLine: isLine }),
      }),
    }),
  ),
});

const sarifRunFields = fields({
  tool: fields({
    driver: fields({
      name: isString,
      rules: arrayOf(fields({ id: isString, properties: sarifProperties })),
    }),
  }),
  invocations: arrayOf(sarifInvocation),
  results: (value) => value === null || arrayOf(sarifResult)(value),
});
function sarifRun(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.tool) || !isRecord(value.tool.driver)) return false;
  const name = value.tool.driver.name;
  return typeof name === "string" && name.trim().length > 0 && sarifRunFields(value);
}

/** Read only validated records when a peer record damages the report. */
function readableSarifRun(value: unknown): Record<string, unknown> | undefined {
  if (sarifRun(value)) return value;
  if (!isRecord(value)) return undefined;
  const results = Array.isArray(value.results) ? value.results.filter(sarifResult) : undefined;
  const invocations = Array.isArray(value.invocations)
    ? value.invocations.filter(sarifInvocation)
    : undefined;
  const recovered = { ...value, results, invocations };
  return sarifRun(recovered) ? recovered : undefined;
}

const osvVulnerabilityFields = fields({
  id: isString,
  summary: isString,
  database_specific: fields({ severity: isString }),
});
const osvPackageIdentity = fields({
  name: isString,
  ecosystem: isString,
  version: isString,
  commit: isString,
});
const osvPackageFields = fields({
  package: osvPackageIdentity,
  vulnerabilities: arrayOf(osvVulnerability),
});

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function osvVulnerability(value: unknown): value is OsvVuln & { id: string } {
  return isRecord(value) && nonBlank(value.id) && osvVulnerabilityFields(value);
}

function identifiedOsvPackage(value: unknown, declaresVulnerabilities: boolean): boolean {
  if (!isRecord(value)) return false;
  if (nonBlank(value.commit)) return true;
  return (
    nonBlank(value.name) &&
    (declaresVulnerabilities || (nonBlank(value.version) && nonBlank(value.ecosystem)))
  );
}

function completeOsvGroups(groups: unknown, ids: ReadonlySet<string>): boolean {
  if (groups === undefined) return true;
  if (!Array.isArray(groups)) return false;
  return groups.every(
    (group: unknown) =>
      isRecord(group) &&
      Array.isArray(group.ids) &&
      group.ids.length > 0 &&
      group.ids.every((id: unknown) => nonBlank(id) && ids.has(id)),
  );
}

function osvPackage(value: unknown): value is OsvPackage {
  if (!isRecord(value) || !osvPackageFields(value)) return false;
  const vulnerabilities = Array.isArray(value.vulnerabilities) ? value.vulnerabilities : [];
  const ids = new Set(vulnerabilities.map((vulnerability: { id: string }) => vulnerability.id));
  return (
    completeOsvGroups(value.groups, ids) &&
    (ids.size > 0 || identifiedOsvPackage(value.package, Array.isArray(value.vulnerabilities)))
  );
}

function osvResult(value: unknown): value is OsvResult {
  return isRecord(value) && Array.isArray(value.packages) && value.packages.every(osvPackage);
}

function readableOsvPackage(value: unknown): OsvPackage | undefined {
  if (osvPackage(value)) return value;
  if (!isRecord(value)) return undefined;
  const vulnerabilities = Array.isArray(value.vulnerabilities)
    ? value.vulnerabilities.filter(osvVulnerability)
    : [];
  const recovered = {
    package: osvPackageIdentity(value.package) ? value.package : undefined,
    vulnerabilities,
  };
  return osvPackage(recovered) ? recovered : undefined;
}

function readableOsvResult(value: unknown): OsvResult | undefined {
  if (osvResult(value)) return value;
  if (!isRecord(value) || !Array.isArray(value.packages)) return undefined;
  const packages = value.packages.map(readableOsvPackage).filter((entry) => entry !== undefined);
  return { packages };
}

function ingestOsvReport(parsed: unknown): IngestOutcome {
  if (!isRecord(parsed)) return reportFailure("malformed", "not an OSV report");
  const { results } = parsed;
  if (results === null) return reportFailure("missing", "OSV report has no results array");
  if (!Array.isArray(results)) return reportFailure("malformed", "invalid OSV report structure");
  if (results.every(osvResult)) return { ok: true, findings: osvFindings({ results }) };
  const readable = results.map(readableOsvResult).filter((entry) => entry !== undefined);
  const findings = osvFindings({ results: readable });
  return incompleteReport("malformed", findings, ["The OSV report contains invalid records."]);
}

function reportFailure(reportGap: IngestGap, reason: string): IngestOutcome {
  return { ok: false, reportGap, reason };
}

function incompleteReport(
  reportGap: IngestGap,
  findings: SecurityCheckResult[],
  notes: string[],
): IngestOutcome {
  return findings.length > 0
    ? { ok: true, findings, coverage: "partial", reportGap, notes }
    : reportFailure(reportGap, notes.join(" ") + " Scan coverage is unverified.");
}

function hasErrorNotification(notifications: unknown): boolean {
  return (
    Array.isArray(notifications) &&
    notifications.some((entry) => isRecord(entry) && entry.level === "error")
  );
}

function sarifRunCoverage(run: Record<string, unknown>) {
  const invocations = Array.isArray(run.invocations) ? run.invocations.filter(isRecord) : [];
  return {
    hasResults: Array.isArray(run.results),
    stopped: invocations.some((entry) => entry.executionSuccessful === false),
    errors: invocations.some(
      (entry) =>
        hasErrorNotification(entry.toolExecutionNotifications) ||
        hasErrorNotification(entry.toolConfigurationNotifications),
    ),
  };
}

const SCANNER_STATUSES = new Set([
  "ran",
  "not-applicable",
  "not-installed",
  "no-token",
  "error",
  "partial",
  "timed-out",
]);
const REPORT_GAPS = new Set(["missing", "partial", "malformed", "unsupported"]);

function scannerCoverageEntry(value: unknown): value is DeclaredScannerCoverage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.status === "string" &&
    SCANNER_STATUSES.has(value.status) &&
    typeof value.findings === "number" &&
    Number.isSafeInteger(value.findings) &&
    value.findings >= 0 &&
    (value.reportGap === undefined ||
      (typeof value.reportGap === "string" && REPORT_GAPS.has(value.reportGap)))
  );
}

function kitScanCoverage(runs: SarifRun[]) {
  const scanners: DeclaredScannerCoverage[] = [];
  let malformed = false;
  let partial = false;
  for (const run of runs) {
    if (run.tool?.driver?.name !== "kit" || run.properties === undefined) continue;
    if (!isRecord(run.properties)) {
      malformed = true;
      continue;
    }
    const { scannerCoverage, scopeGaps } = run.properties;
    const scope = kitScopeCoverage(scopeGaps);
    const declared = kitDelegateCoverage(scannerCoverage);
    malformed ||= scope === "malformed" || declared.malformed;
    partial ||= scope === "partial" || declared.partial;
    for (const scanner of declared.scanners) scanners.push(scanner);
  }
  return { scanners, malformed, partial };
}

function kitScopeCoverage(scopeGaps: unknown): "complete" | "malformed" | "partial" {
  if (scopeGaps === undefined) return "complete";
  if (!Array.isArray(scopeGaps) || !scopeGaps.every(isRecord)) return "malformed";
  return scopeGaps.length ? "partial" : "complete";
}

function kitDelegateCoverage(scannerCoverage: unknown) {
  const scanners: DeclaredScannerCoverage[] = [];
  if (scannerCoverage === undefined) return { scanners, malformed: false, partial: false };
  if (!Array.isArray(scannerCoverage)) return { scanners, malformed: true, partial: false };
  const records = scannerCoverage.filter(scannerCoverageEntry);
  let partial = !records.some(({ status }) => status === "ran");
  for (const { id, status, findings, reportGap } of records) {
    if (reportGap || (status !== "ran" && status !== "not-applicable")) partial = true;
    scanners.push({ id, status, findings, reportGap });
  }
  return { scanners, malformed: records.length !== scannerCoverage.length, partial };
}

/** Read findings and declared coverage from a SARIF 2.1.0 report. */
export function ingestSarifReport(parsed: unknown): IngestOutcome {
  if (!isRecord(parsed)) return reportFailure("malformed", "not a SARIF log");
  const { version, runs } = parsed;
  if (version !== undefined && typeof version !== "string")
    return reportFailure("malformed", "invalid SARIF version field");
  if (version !== undefined && version !== "2.1.0")
    return reportFailure("unsupported", "unsupported SARIF version (kit reads SARIF 2.1.0)");
  if (runs === null || (version === "2.1.0" && runs === undefined))
    return reportFailure("missing", "SARIF log has no runs array");
  if (!Array.isArray(runs)) return reportFailure("malformed", "invalid SARIF report structure");
  if (runs.length === 0) return reportFailure("missing", "SARIF log contains no runs");
  const readable = runs.map(readableSarifRun).filter(isRecord);
  const normalized = readable as SarifRun[];
  const findings = sarifFindings({ runs: normalized });
  const declared = kitScanCoverage(normalized);
  const outcome = sarifCoverage(readable, findings, {
    malformed: !runs.every(sarifRun) || declared.malformed,
    declaredPartial: declared.partial,
  });
  const scannerCoverage = declared.scanners;
  return scannerCoverage.length ? { ...outcome, scannerCoverage } : outcome;
}

function sarifCoverage(
  runs: Record<string, unknown>[],
  findings: SecurityCheckResult[],
  { malformed, declaredPartial }: { malformed: boolean; declaredPartial: boolean },
): IngestOutcome {
  const coverage = runs.map(sarifRunCoverage);
  const stopped = coverage.some((run) => run.stopped);
  const errors = coverage.some((run) => run.errors);
  const missingResults = coverage.some((run) => !run.hasResults);
  const notes: string[] = [];
  if (stopped) notes.push("The SARIF report contains a stopped run (executionSuccessful: false).");
  if (errors) notes.push("The SARIF report contains an execution or configuration error.");
  if (missingResults) notes.push("At least one SARIF run has no results array.");
  if (declaredPartial) notes.push("The Kit SARIF report declares incomplete scan coverage.");
  if (malformed) notes.push("The SARIF report contains invalid records.");
  if (notes.length === 0) return { ok: true, findings };
  const missing =
    !stopped && !errors && !declaredPartial && coverage.every((run) => !run.hasResults);
  return incompleteReport(
    malformed ? "malformed" : missing ? "missing" : "partial",
    findings,
    notes,
  );
}

export function ingestStrict(format: IngestFormat, json: string): IngestOutcome {
  if (!json.trim()) return reportFailure("missing", "scanner report is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return reportFailure("malformed", "output is not valid JSON");
  }
  if (format === "sarif") return ingestSarifReport(parsed);
  if (format === "osv") return ingestOsvReport(parsed);
  if (format === "cloudflare-audit") return ingestCloudflareAudit(parsed);
  return { ok: false, reason: "unknown report format" };
}
