/**
 * Third-party scanners can add findings to the `kit check` verdict.
 *
 * Contract: a tool appends one JSON object per line to `.kit-scan-results.jsonl`
 * in the project root. Kit groups findings by source.
 *
 * Example finding
 *   {"source":"snyk","severity":"high","id":"SNYK-1","title":"Vulnerability","package":"lodash"}
 * `source` (non-empty string) and `severity` (critical|high|medium|low) are required.
 *
 * High and critical findings fail the gate. Medium and low findings warn.
 * Ingestion only adds findings or reports coverage gaps. It never emits a pass.
 *
 * Legacy JSONL records findings only. It cannot establish scanner completeness
 * or freshness. A record timestamp or file modification time cannot bind a scan
 * to the current inputs. All valid findings still count, regardless of their age.
 */
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, statSync, type BigIntStats } from "node:fs";
import { resolve } from "node:path";
import {
  isOtherScannerFormat,
  scannerObject,
  type ScannerReportGap,
} from "./check-scanner-evidence.js";
import type { SecurityCheckResult } from "./check-security.js";
import { readRegularFileBytesIfPresent } from "./upstream-safe-read.js";
import { redactSecrets } from "./utils/redactSecrets.js";
import { sameIdentity } from "./utils/same-file.js";

/** The de-facto sink kit-plugin-snyk/wiz/sentrux already append to. */
export const EXTERNAL_FINDINGS_FILE = ".kit-scan-results.jsonl";

export type ExternalSeverity = "critical" | "high" | "medium" | "low";

export interface ExternalFinding {
  source: string;
  severity: ExternalSeverity;
  title?: string;
  id?: string;
  package?: string;
}

export interface ParsedExternalFindings {
  findings: ExternalFinding[];
  /** Non-empty lines that were not a usable finding object (surfaced, never silent). */
  malformed: number;
}

const RANK: Record<ExternalSeverity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/**
 * Map producer aliases to kit's severity tiers. An unknown severity is malformed.
 */
function normalizeSeverity(raw: string): ExternalSeverity | null {
  switch (raw.trim().toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
    case "moderate":
      return "medium";
    case "low":
    case "info":
    case "informational":
      return "low";
    default:
      return null;
  }
}

/** Decode each record so invalid UTF-8 cannot hide findings on other lines. */
function* reportLines(input: string | Buffer): Iterable<string | undefined> {
  if (typeof input === "string") {
    yield* input.split("\n");
    return;
  }
  for (let start = 0; start < input.length;) {
    const newline = input.indexOf(0x0a, start);
    const end = newline === -1 ? input.length : newline;
    const line = input.subarray(start, end);
    yield isUtf8(line) ? line.toString("utf8") : undefined;
    start = end + 1;
  }
}

/** Parse finding records and count unusable nonempty records. */
export function parseExternalFindings(input: string | Buffer): ParsedExternalFindings {
  const findings: ExternalFinding[] = [];
  let malformed = 0;
  for (const raw of reportLines(input)) {
    const line = raw?.trim();
    if (line === "") continue;
    const obj = line === undefined ? undefined : scannerObject(line);
    if (!obj) {
      malformed++;
      continue;
    }
    const source = typeof obj.source === "string" ? obj.source.trim() : "";
    const severity = typeof obj.severity === "string" ? normalizeSeverity(obj.severity) : null;
    if (!source || !severity) {
      malformed++;
      continue;
    }
    findings.push({
      source,
      severity,
      title: typeof obj.title === "string" ? obj.title : undefined,
      id: typeof obj.id === "string" ? obj.id : undefined,
      package: typeof obj.package === "string" ? obj.package : undefined,
    });
  }
  return { findings, malformed };
}

/** Group findings by source and report a separate coverage gap for invalid rows. */
export function externalFindingResults(parsed: ParsedExternalFindings): SecurityCheckResult[] {
  const bySource = new Map<string, ExternalFinding[]>();
  for (const f of parsed.findings) {
    const arr = bySource.get(f.source) ?? [];
    arr.push(f);
    bySource.set(f.source, arr);
  }
  const out = [...bySource.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source, findings]) => findingResult(source, findings));
  if (parsed.malformed > 0) {
    out.push(
      coverageGap(
        parsed.findings.length ? "partial" : "malformed",
        `${parsed.malformed} unparseable line(s) in ${EXTERNAL_FINDINGS_FILE}. Check the emitting tool.`,
        "external findings (parse)",
      ),
    );
  }
  return out;
}

function findingResult(source: string, findings: ExternalFinding[]): SecurityCheckResult {
  const counts: Record<ExternalSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let worst: ExternalSeverity = "low";
  for (const finding of findings) {
    counts[finding.severity]++;
    if (RANK[finding.severity] > RANK[worst]) worst = finding.severity;
  }
  const summary = (Object.keys(counts) as ExternalSeverity[])
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`)
    .join(", ");
  const label = sourceLabel(source);
  return {
    category: "supply-chain",
    name: `external: ${label}`,
    status: RANK[worst] >= RANK.high ? "fail" : "warn",
    detail: `${findings.length} finding(s) from ${label} (${summary}). Legacy JSONL cannot establish scanner completeness and freshness.`,
    severity: worst,
    hasFindings: true,
    scanIncomplete: true,
    evidenceStatus: "partial",
  };
}

function sourceLabel(source: string): string {
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(source) && redactSecrets(source) === source) {
    return source;
  }
  return `source [${createHash("sha256").update(source).digest("hex").slice(0, 12)}]`;
}

function coverageGap(
  evidenceStatus: ScannerReportGap | "stale",
  detail: string,
  name = "external findings",
): SecurityCheckResult {
  return {
    category: "supply-chain",
    name,
    status: "warn",
    detail,
    severity: "low",
    didNotRun: true,
    scanIncomplete: true,
    evidenceStatus,
  };
}

function readFailure(error: unknown): SecurityCheckResult {
  // The shared bounded reader uses fixed messages for these conditions.
  switch (error instanceof Error ? error.message : undefined) {
    case "is not a regular file":
    case "is a symlink, not read":
      return unsupportedEntry();
    case "is too large to read":
      return coverageGap("partial", `${EXTERNAL_FINDINGS_FILE} exceeds the report size limit.`);
    case "file size changed while it was read":
    case "changed while it was read":
      return changedReport();
    default:
      return unavailableReport();
  }
}

function unsupportedEntry(): SecurityCheckResult {
  return coverageGap("unsupported", `${EXTERNAL_FINDINGS_FILE} must be a regular file.`);
}

function unavailableReport(): SecurityCheckResult {
  return coverageGap("unavailable", `Could not read ${EXTERNAL_FINDINGS_FILE}.`);
}

function changedReport(): SecurityCheckResult {
  return coverageGap("stale", `${EXTERNAL_FINDINGS_FILE} changed during the read.`);
}

function reportFileStat(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

function recheckReport(
  path: string,
  initial: BigIntStats,
  readSize?: number,
): SecurityCheckResult | undefined {
  if (readSize !== undefined && BigInt(readSize) !== initial.size) return changedReport();
  try {
    const current = reportFileStat(path);
    if (
      !current?.isFile() ||
      !sameIdentity(current, initial) ||
      current.size !== initial.size ||
      current.mtimeNs !== initial.mtimeNs ||
      current.ctimeNs !== initial.ctimeNs
    ) {
      return changedReport();
    }
  } catch {
    return unavailableReport();
  }
}

/** Ingest an optional report from the project root. */
export async function checkExternalFindings(
  cwd: string = process.cwd(),
): Promise<SecurityCheckResult[]> {
  const path = resolve(cwd, EXTERNAL_FINDINGS_FILE);
  let initial: BigIntStats | undefined;
  let bytes: Buffer | null;
  try {
    // This also detects dangling links on platforms without O_NOFOLLOW.
    initial = reportFileStat(path);
    if (!initial) return statSync(cwd).isDirectory() ? [] : [unavailableReport()];
    if (!initial.isFile()) return [unsupportedEntry()];
    bytes = readRegularFileBytesIfPresent(path);
  } catch (error) {
    const observed = initial && recheckReport(path, initial);
    return [observed?.evidenceStatus === "stale" ? observed : readFailure(error)];
  }
  if (!bytes) return [changedReport()];
  return reportResults(bytes, recheckReport(path, initial, bytes.byteLength));
}

function reportResults(bytes: Buffer, readGap?: SecurityCheckResult): SecurityCheckResult[] {
  const parsed = parseExternalFindings(bytes);
  if (parsed.findings.length) {
    const results = externalFindingResults(parsed);
    if (readGap) results.push(readGap);
    return results;
  }
  if (readGap) return [readGap];
  if (!parsed.malformed) {
    return [
      {
        category: "supply-chain",
        name: "external findings",
        status: "skip",
        detail: `${EXTERNAL_FINDINGS_FILE} contains no finding records. Scan coverage is unknown.`,
        evidenceStatus: "missing",
      },
    ];
  }
  const document = isUtf8(bytes) ? scannerObject(bytes.toString("utf8").trim()) : undefined;
  if (document && isOtherScannerFormat(document)) {
    return [coverageGap("unsupported", `${EXTERNAL_FINDINGS_FILE} requires finding JSONL.`)];
  }
  return externalFindingResults(parsed);
}
