import type { SecurityCheckResult } from "./check-security.js";
import {
  reportText,
  scannerEvidence,
  scannerGap,
  scannerRecord,
  type ScannerReport,
} from "./check-scanner-evidence.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";
import { parseJsonObject } from "./utils/json-object.js";

export const GUARDDOG_CHECK = { category: "supply-chain", name: "guarddog (malware)" } as const;
export type GuardDogEcosystem = "npm" | "pypi";

interface GuardDogScope {
  ecosystem: GuardDogEcosystem;
  selectors: Map<string, Set<string>>;
  gap?: "malformed" | "partial";
}

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

const NPM_NAME = /^(?:@[a-z\d_~][a-z\d._~-]*\/)?[a-z\d_~][a-z\d._~-]*$/i;
const NPM_ALIAS = /^npm:((?:@[^/@\s]+\/)?[^@/\s]+)(?:@(.+))?$/;
const NPM_SELECTOR = /^(?!\.)[a-z\d.^~<>=|*+ -]*$/i;
const NPM_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const PYPI_NAME = /^[a-z\d](?:[a-z\d._-]*[a-z\d])?$/i;
const PYPI_REQUIREMENT =
  /^([a-z\d](?:[a-z\d._-]*[a-z\d])?)(?:\s*\[[a-z\d._,\s-]+\])?\s*(?:(===|==|!=|~=|<=|>=|<|>)\s*([\w.*!+-]+))?\s*(?:;[^#\\]+)?$/i;
// The report gives packaging.version.Version's normalized version, without a leading v.
const PYPI_VERSION =
  /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z\d]+(?:\.[a-z\d]+)*)?$/i;

function normalizeName(ecosystem: GuardDogEcosystem, name: string): string {
  return ecosystem === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}

function addValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function pypiScope(scope: GuardDogScope, raw: Uint8Array): GuardDogScope {
  let manifest: string;
  try {
    manifest = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return { ...scope, gap: "malformed" };
  }
  for (const rawLine of manifest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const requirement = PYPI_REQUIREMENT.exec(line);
    // GuardDog skips indented requirements and pip directives. A comma-separated
    // specifier set also falls outside its single-Specifier resolver.
    if (!requirement || !/^\w/.test(rawLine)) {
      scope.gap = "partial";
      continue;
    }
    const [, name, operator, version] = requirement;
    addValue(scope.selectors, normalizeName("pypi", name), operator ? operator + version : "");
  }
  return scope;
}

function npmScope(scope: GuardDogScope, raw: Uint8Array): GuardDogScope {
  const parsed = parseJsonObject(raw, MAX_MANIFEST_BYTES);
  if ("issues" in parsed) return { ...scope, gap: "malformed" };
  const manifest = parsed.value;
  for (const key of ["dependencies", "devDependencies"]) {
    const group = manifest[key];
    if (group === undefined) continue;
    if (!scannerRecord(group)) return { ...scope, gap: "malformed" };
    for (const [name, spec] of Object.entries(group)) {
      if (!NPM_NAME.test(name) || typeof spec !== "string") return { ...scope, gap: "malformed" };
      const alias = NPM_ALIAS.exec(spec);
      const dependency = alias?.[1] ?? name;
      const selector = (alias ? (alias[2] ?? "*") : spec).trim();
      if (!NPM_NAME.test(dependency) || !NPM_SELECTOR.test(selector)) {
        scope.gap = "partial";
        continue;
      }
      addValue(scope.selectors, dependency, selector);
    }
  }
  return scope;
}

export function guardDogScope(ecosystem: GuardDogEcosystem, raw: Buffer | string): GuardDogScope {
  const scope: GuardDogScope = { ecosystem, selectors: new Map() };
  const bytes = typeof raw === "string" ? Buffer.from(raw) : raw;
  if (bytes.byteLength > MAX_MANIFEST_BYTES) return { ...scope, gap: "malformed" };
  return ecosystem === "npm" ? npmScope(scope, bytes) : pypiScope(scope, bytes);
}

function exactVersion(ecosystem: GuardDogEcosystem, selector: string): string | undefined {
  if (ecosystem === "npm") {
    const version = selector.replace(/^(?:=\s*)?v?/, "");
    return NPM_VERSION.test(version) ? version : undefined;
  }
  const pin = /^===?([^*]+)$/.exec(selector);
  return pin?.[1];
}

/** Numeric PyPI release segments compare with zero padding, e.g. 1.2 equals 1.2.0. */
function pypiVersionKey(version: string): string {
  return version
    .toLowerCase()
    .replace(
      /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(.*)$/i,
      (_, epoch: string | undefined, release: string, suffix: string) => {
        const normalized = release
          .split(".")
          .map((part) => part.replace(/^0+(?=\d)/, ""))
          .join(".");
        const epochNumber = epoch?.replace(/^0+(?=\d)/, "");
        return (
          (epochNumber && epochNumber !== "0" ? epochNumber + "!" : "") +
          normalized.replace(/(?:\.0)+$/, "") +
          suffix
        );
      },
    );
}

function coversSelectors(
  ecosystem: GuardDogEcosystem,
  observed: Set<string>,
  selectors: Set<string>,
): boolean {
  for (const selector of selectors) {
    const exact = exactVersion(ecosystem, selector);
    if (exact === undefined) {
      // GuardDog resolves one selector to registry versions. Its report does not
      // say which selector produced each version when several selectors were merged.
      if (selectors.size !== 1) return false;
      continue;
    }
    if (ecosystem === "npm") {
      if (!observed.has(exact)) return false;
    } else {
      const key = selector.startsWith("===")
        ? (version: string) => version.toLowerCase()
        : pypiVersionKey;
      if (![...observed].some((version) => key(version) === key(exact))) return false;
    }
  }
  return true;
}

function sourceFinding(value: unknown): boolean {
  return (
    scannerRecord(value) &&
    reportText(value.location) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function parseVerifyEntries(stdout: string): unknown[] | undefined {
  // npm and PyPI verify both emit arrays of dependency/version/result envelopes.
  const raw = stdout.trim();
  if (!raw.startsWith("[") || !raw.endsWith("]")) return undefined;
  // Reuse the bounded JSON reader and reject extra keys outside the wrapped array.
  const prefix = '{"entries":';
  const parsed = parseJsonObject(
    Buffer.from(prefix + stdout + "}"),
    MAX_REPORT_BYTES + prefix.length + 1,
  );
  if ("issues" in parsed || Object.keys(parsed.value).length !== 1) return undefined;
  return Array.isArray(parsed.value.entries) ? parsed.value.entries : undefined;
}

function validRuleResults(ruleResults: unknown[] | undefined, reportedIssues: boolean): boolean {
  if (!ruleResults || ruleResults.some(hasRuleFinding) !== reportedIssues) return false;
  return ruleResults.every(
    (value) =>
      value === null ||
      reportText(value) ||
      (Array.isArray(value) && value.every(sourceFinding)) ||
      (scannerRecord(value) && Object.keys(value).length === 0),
  );
}

function hasRuleFinding(value: unknown): boolean {
  return reportText(value) || (Array.isArray(value) && value.some(sourceFinding));
}

function countIndicators(result: Record<string, unknown>): ScannerReport {
  const { issues, errors, results } = result;
  const issueCount =
    typeof issues === "number" && Number.isSafeInteger(issues) && issues >= 0 ? issues : undefined;
  const messages = scannerRecord(errors) ? Object.values(errors) : undefined;
  const ruleResults = scannerRecord(results) ? Object.values(results) : undefined;
  const hasFinding = ruleResults?.some(hasRuleFinding);
  const count = Math.max(issueCount ?? 0, hasFinding ? 1 : 0);
  if (issueCount === undefined || !messages || !messages.every(reportText)) {
    return { count, gap: "malformed" };
  }
  // A download failure has issues: 0 and an errors map, and can omit results.
  if (messages.length > 0) return { count, gap: "partial" };
  if (!validRuleResults(ruleResults, issueCount > 0)) {
    return { count, gap: "malformed" };
  }
  return { count };
}

function packageEnvelope(entry: unknown, namePattern: RegExp) {
  if (
    !scannerRecord(entry) ||
    !reportText(entry.dependency) ||
    !namePattern.test(entry.dependency) ||
    !reportText(entry.version) ||
    !scannerRecord(entry.result)
  )
    return undefined;
  return { dependency: entry.dependency, version: entry.version, result: entry.result };
}

function packageRows(entries: unknown[], ecosystem: GuardDogEcosystem) {
  const namePattern = ecosystem === "npm" ? NPM_NAME : PYPI_NAME;
  const versionPattern = ecosystem === "npm" ? NPM_VERSION : PYPI_VERSION;
  const versions = new Map<string, Set<string>>();
  const findings = new Map<string, number>();
  let malformed = false;
  let partial = false;
  let hasValidRow = false;
  for (const value of entries) {
    const entry = packageEnvelope(value, namePattern);
    if (!entry) {
      malformed = true;
      continue;
    }
    const name = normalizeName(ecosystem, entry.dependency);
    const version = ecosystem === "pypi" ? pypiVersionKey(entry.version) : entry.version;
    const outcome = countIndicators(entry.result);
    const identity = JSON.stringify([name, version]);
    findings.set(identity, Math.max(findings.get(identity) ?? 0, outcome.count));
    if (outcome.gap === "malformed") {
      malformed = true;
      continue;
    }
    hasValidRow = true;
    const { package_version: packageVersion } = entry.result;
    if (
      outcome.gap ||
      !versionPattern.test(entry.version) ||
      (packageVersion !== undefined && packageVersion !== entry.version)
    ) {
      partial = true;
      continue;
    }
    addValue(versions, name, entry.version);
  }

  const count = [...findings.values()].reduce((sum, issues) => sum + issues, 0);
  const gap = rowGap(malformed, hasValidRow || count > 0, partial);
  return { count, versions, gap };
}

function rowGap(malformed: boolean, hasUsableEvidence: boolean, partial: boolean) {
  if (malformed) return hasUsableEvidence ? "partial" : "malformed";
  return partial ? "partial" : undefined;
}

function readGuardDogReport(
  result: Pick<ExecResult, "stdout" | "stderr">,
  scope: GuardDogScope,
): ScannerReport {
  const { stdout, stderr } = result;
  if (!stdout.trim()) return { count: 0, gap: "missing" };
  const entries = parseVerifyEntries(stdout);
  if (!entries) return { count: 0, gap: "malformed" };
  const { count, versions, gap } = packageRows(entries, scope.ecosystem);
  if (gap === "malformed") return { count, gap };
  if (scope.gap) {
    return {
      count,
      gap: scope.gap,
      note: "GuardDog could not verify the selected manifest format or dependency selectors",
    };
  }
  if (entries.length === 0 && scope.selectors.size > 0) {
    return {
      count,
      gap: "missing",
      note: "GuardDog returned no package results for a populated manifest",
    };
  }
  if (
    /^(?:ERROR|CRITICAL):/m.test(stderr) ||
    /^WARNING: Received keyboard interrupt/m.test(stderr)
  ) {
    return {
      count,
      gap: "partial",
      note: "GuardDog reported errors while resolving or scanning dependencies",
    };
  }
  if (gap === "partial") {
    return {
      count,
      gap: "partial",
      note: "GuardDog returned invalid package results or could not complete package rules",
    };
  }
  for (const [name, selectors] of scope.selectors) {
    const observed = versions.get(name);
    if (!observed || !coversSelectors(scope.ecosystem, observed, selectors)) {
      return {
        count,
        gap: "partial",
        note: "GuardDog did not verify all dependency selectors in the manifest",
      };
    }
  }
  if (versions.size !== scope.selectors.size) {
    return {
      count,
      gap: "partial",
      note: "GuardDog reported packages outside the selected manifest",
    };
  }
  return { count };
}

export function classifyGuardDog(
  result: ExecResult,
  scope: GuardDogScope,
  manifestChanged = false,
): SecurityCheckResult {
  const report = readGuardDogReport(result, scope);
  const { count } = report;
  const row: SecurityCheckResult =
    count > 0
      ? {
          ...GUARDDOG_CHECK,
          status: "fail",
          detail:
            count + " malware indicator(s). Inspect with guarddog " + scope.ecosystem + " verify",
          severity: "critical",
          hasFindings: true,
        }
      : {
          ...GUARDDOG_CHECK,
          status: "pass",
          detail:
            scope.selectors.size > 0
              ? "no malware indicators (" + scope.selectors.size + " direct dependencies covered)"
              : scope.ecosystem === "npm"
                ? "no dependencies or devDependencies to scan"
                : "no requirements to scan",
        };
  // This invocation does not set --exit-non-zero-on-finding. Exit 1 only
  // means a missing target when GuardDog also emitted its specific diagnostic.
  const missingTarget =
    !result.stdout.trim() &&
    /^ERROR: Error while scanning\. Received unable to find file or directory (?:package\.json|requirements\.txt)\r?$/m.test(
      result.stderr,
    );
  const gap = scannerGap(report, result, missingTarget ? { noTarget: 1 } : {});
  return scannerEvidence(
    row,
    count,
    gap ??
      (manifestChanged
        ? { status: "partial", reason: "GuardDog manifest changed during the scan" }
        : undefined),
  );
}
