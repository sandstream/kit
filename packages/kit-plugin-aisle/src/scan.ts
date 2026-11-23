/**
 * AISLE nano-analyzer result ingestion. Read-only by design: this plugin
 * consumes local nano-analyzer output and writes kit's local
 * `.kit-scan-results.jsonl`; it never calls AISLE, GitHub, or a model.
 *
 * Supported source today:
 *
 *   python3 scan.py ./src --output-dir ./aisle-results
 *
 * Then either:
 *
 *   ingestAisleNanoOutputDir("./aisle-results")
 *
 * or parse `triage.json` yourself and call `recordAisleNanoFindings`.
 */

import { appendFile, readFile } from "node:fs/promises";
import { join, posix, resolve, win32 } from "node:path";

const SCAN_RESULTS_FILE = ".kit-scan-results.jsonl";

export type Severity = "low" | "medium" | "high" | "critical";

export interface AisleNanoRound {
  verdict?: string;
  reasoning?: string;
  round?: number;
  file?: string;
  finding_title?: string;
}

export interface AisleNanoTriageFinding {
  id?: string;
  file?: string;
  finding_title?: string;
  title?: string;
  severity?: string;
  verdict?: string;
  confidence?: number;
  verdicts_str?: string;
  reasoning?: string;
  triage_md?: string;
  all_rounds?: AisleNanoRound[];
}

export interface AisleNanoSummary {
  timestamp?: string;
  target?: string;
  model?: string;
  coverage?: "partial";
  completeEmpty?: true;
  per_file?: Array<{
    file?: string;
    severities?: Record<string, number>;
  }>;
}

export interface AisleKitFinding {
  source: "aisle";
  scanner: "nano-analyzer";
  severity: Severity;
  id: string;
  title: string;
  file?: string;
  confidence?: number;
  verdict: string;
  verdicts?: string;
  triage?: string;
  target?: string;
  model?: string;
  observed_at?: string;
}

export interface RecordAisleNanoOptions {
  /**
   * Optional nano-analyzer `summary.json`; used for target/model metadata and
   * as a severity fallback because `triage.json` does not always carry per-
   * finding severity.
   */
  summary?: AisleNanoSummary;
  /** Write VALID findings at or above this confidence. Default: 0. */
  minConfidence?: number;
  /** Fallback severity when neither triage nor summary exposes one. Default: high. */
  defaultSeverity?: Severity;
  /** Include non-VALID findings as warnings. Default: false. */
  includeRejected?: boolean;
}

export function normalizeSeverity(raw: unknown, fallback: Severity = "medium"): Severity {
  const s = String(raw ?? "").toLowerCase();
  if (s === "critical" || s === "crit" || s === "blocker") return "critical";
  if (s === "high" || s === "error" || s === "major") return "high";
  if (s === "medium" || s === "moderate" || s === "warning") return "medium";
  if (s === "low" || s === "info" || s === "informational" || s === "minor" || s === "note") {
    return "low";
  }
  return fallback;
}

export function parseAisleNanoTriageJson(text: string): AisleNanoTriageFinding[] {
  const { findings, partial } = readTriageReport(text);
  if (partial) throw new Error("Invalid AISLE triage report: invalid finding records");
  return findings;
}

function readTriageReport(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid AISLE nano-analyzer triage JSON: ${err instanceof Error ? err.message : err}`,
      {
        cause: err,
      },
    );
  }

  const raw = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { findings?: unknown[] }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : undefined;
  if (!raw) throw new Error("Invalid AISLE triage report: expected a findings array");

  const findings = raw.map(normalizeTriageFinding).filter((finding) => finding !== undefined);
  return { findings, partial: findings.length !== raw.length };
}

interface AisleSummaryRecord {
  timestamp?: string;
  target?: string;
  model?: string;
  per_file: unknown[];
  files_scanned?: unknown;
  error_files?: unknown;
  files_skipped?: unknown;
  clean_files?: unknown;
}

function readAisleSummary(text: string): AisleSummaryRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid AISLE nano-analyzer summary JSON: ${err instanceof Error ? err.message : err}`,
      {
        cause: err,
      },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid AISLE summary: expected a JSON object");
  }

  if (!("per_file" in parsed) || !Array.isArray(parsed.per_file)) {
    throw new Error("Invalid AISLE summary: expected per_file array");
  }
  return parsed as AisleSummaryRecord;
}

function readAisleSummaryRow(entry: unknown) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  const value = entry as { file?: unknown; severities?: unknown; status?: unknown };
  const file = str(value.file);
  const severities = objectRecord(value.severities);
  return file ? [{ file, severities, status: value.status }] : [];
}

type AisleSummaryRow = ReturnType<typeof readAisleSummaryRow>[number];

function hasDistinctAislePaths(
  target: string | undefined,
  perFile: readonly AisleSummaryRow[],
): boolean {
  if (!target) return false;
  const paths = posix.isAbsolute(target) ? posix : win32.isAbsolute(target) ? win32 : undefined;
  if (!paths) return false;
  const checked = new Set<string>();
  for (const { file } of perFile) {
    const normalized = paths.normalize(file);
    if (
      paths.parse(normalized).root ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith(`..${paths.sep}`) ||
      normalized.endsWith(paths.sep) ||
      checked.has(normalized)
    )
      return false;
    checked.add(normalized);
  }
  return true;
}

function summaryIsPartial(r: AisleSummaryRecord, perFile: readonly AisleSummaryRow[]): boolean {
  return (
    perFile.length === 0 ||
    perFile.length !== r.per_file.length ||
    !hasDistinctAislePaths(str(r.target), perFile) ||
    (r.files_scanned !== undefined && r.files_scanned !== r.per_file.length) ||
    (r.error_files !== undefined && r.error_files !== 0) ||
    (r.files_skipped !== undefined && r.files_skipped !== 0) ||
    perFile.some(
      (entry) => !entry.severities || (entry.status !== undefined && entry.status !== "ok"),
    )
  );
}

function summaryProvesEmpty(r: AisleSummaryRecord, perFile: readonly AisleSummaryRow[]): boolean {
  return (
    r.files_scanned === perFile.length &&
    r.clean_files === perFile.length &&
    r.error_files === 0 &&
    r.files_skipped === 0 &&
    perFile.every(
      ({ status, severities }) =>
        status === "ok" &&
        severities &&
        Object.keys(severities).length > 0 &&
        Object.values(severities).every((count) => count === 0),
    )
  );
}

export function parseAisleNanoSummaryJson(text: string): AisleNanoSummary {
  const r = readAisleSummary(text);
  const perFile = r.per_file.flatMap(readAisleSummaryRow);
  const partial = summaryIsPartial(r, perFile);
  const completeEmpty = !partial && summaryProvesEmpty(r, perFile);

  return {
    timestamp: str(r.timestamp),
    target: str(r.target),
    model: str(r.model),
    per_file: perFile.map(({ file, severities }) => ({ file, severities })),
    ...(partial ? { coverage: "partial" as const } : {}),
    ...(completeEmpty ? { completeEmpty: true as const } : {}),
  };
}

export function normalizeAisleNanoFindings(
  findings: AisleNanoTriageFinding[],
  opts: RecordAisleNanoOptions = {},
): AisleKitFinding[] {
  const summarySeverityByFile = new Map<string, Severity>();
  for (const f of opts.summary?.per_file ?? []) {
    if (!f.file || !f.severities) continue;
    summarySeverityByFile.set(f.file, topSeverity(f.severities));
  }

  const minConfidence = opts.minConfidence ?? 0;
  const fallbackSeverity = opts.defaultSeverity ?? "high";
  const out: AisleKitFinding[] = [];

  findings.forEach((finding, idx) => {
    const verdict = String(finding.verdict ?? "UNKNOWN").toUpperCase();
    const confidence = typeof finding.confidence === "number" ? finding.confidence : undefined;
    const isValid = verdict === "VALID";

    if (!isValid && !opts.includeRejected) return;
    if (isValid && confidence !== undefined && confidence < minConfidence) return;

    const file = str(finding.file);
    const title = str(finding.finding_title) ?? str(finding.title) ?? "AISLE finding";
    const severity = isValid
      ? normalizeSeverity(
          finding.severity ??
            severityFromText(title) ??
            (file ? summarySeverityByFile.get(file) : undefined),
          fallbackSeverity,
        )
      : "low";

    out.push({
      source: "aisle",
      scanner: "nano-analyzer",
      severity,
      id: str(finding.id) ?? stableId(file, title, idx),
      title,
      file,
      confidence,
      verdict,
      verdicts: str(finding.verdicts_str),
      triage: str(finding.triage_md),
      target: opts.summary?.target,
      model: opts.summary?.model,
      observed_at: opts.summary?.timestamp,
    });
  });

  return out;
}

export async function recordAisleNanoFindings(
  findings: AisleNanoTriageFinding[],
  cwd: string = process.cwd(),
  opts: RecordAisleNanoOptions = {},
): Promise<{ written: number }> {
  const normalized = normalizeAisleNanoFindings(findings, opts);
  if (normalized.length === 0) return { written: 0 };

  const path = resolve(cwd, SCAN_RESULTS_FILE);
  const now = new Date().toISOString();
  const lines = normalized.map((finding) =>
    JSON.stringify({
      timestamp: now,
      ...finding,
    }),
  );
  await appendFile(path, lines.join("\n") + "\n", "utf-8");
  return { written: normalized.length };
}

export async function ingestAisleNanoOutputDir(
  outputDir: string,
  cwd: string = process.cwd(),
  opts: Omit<RecordAisleNanoOptions, "summary"> = {},
): Promise<{ written: number; coverage?: "partial" }> {
  let summary: AisleNanoSummary | undefined;
  try {
    summary = parseAisleNanoSummaryJson(await readFile(join(outputDir, "summary.json"), "utf-8"));
  } catch {
    // The triage report can still supply findings when summary coverage is unavailable.
  }
  let triage;
  try {
    triage = readTriageReport(await readFile(join(outputDir, "triage.json"), "utf-8"));
  } catch (error) {
    if (summary?.completeEmpty && (error as NodeJS.ErrnoException).code === "ENOENT")
      return { written: 0 };
    throw error;
  }

  const partial =
    triage.partial ||
    !summary ||
    summary.coverage === "partial" ||
    (triage.findings.length === 0 && !summary.completeEmpty);
  const result = await recordAisleNanoFindings(triage.findings, cwd, { ...opts, summary });
  if (!partial) return result;
  if (result.written === 0)
    throw new Error("Incomplete AISLE report: no findings could be retained");
  return { ...result, coverage: "partial" };
}

function normalizeTriageFinding(raw: unknown): AisleNanoTriageFinding | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as {
    id?: string;
    file?: string;
    finding_title?: string;
    title?: string;
    severity?: string;
    verdict?: string;
    confidence?: number | string;
    verdicts_str?: string;
    reasoning?: string;
    triage_md?: string;
    all_rounds?: unknown[];
  };
  const verdict = str(r.verdict)?.toUpperCase();
  if (!verdict || !["VALID", "INVALID", "UNCERTAIN"].includes(verdict)) return undefined;
  if (!str(r.finding_title) && !str(r.title)) return undefined;
  return {
    id: str(r.id),
    file: str(r.file),
    finding_title: str(r.finding_title),
    title: str(r.title),
    severity: str(r.severity),
    verdict,
    confidence: numberOrUndefined(r.confidence),
    verdicts_str: str(r.verdicts_str),
    reasoning: str(r.reasoning),
    triage_md: str(r.triage_md),
    all_rounds: Array.isArray(r.all_rounds)
      ? r.all_rounds.map((round) => {
          const rr = (round ?? {}) as AisleNanoRound;
          return {
            verdict: str(rr.verdict),
            reasoning: str(rr.reasoning),
            round: numberOrUndefined(rr.round),
            file: str(rr.file),
            finding_title: str(rr.finding_title),
          };
        })
      : [],
  };
}

function topSeverity(severities: Record<string, number>): Severity {
  const order: Severity[] = ["critical", "high", "medium", "low"];
  for (const sev of order) {
    if ((severities[sev] ?? 0) > 0) return sev;
  }
  if ((severities.informational ?? 0) > 0) return "low";
  return "high";
}

function severityFromText(text: string): Severity | undefined {
  const match = text.match(/\b(critical|crit|high|medium|moderate|low|informational|info)\b/i);
  return match ? normalizeSeverity(match[1], "medium") : undefined;
}

function stableId(file: string | undefined, title: string, idx: number): string {
  const filePart = slug(file ?? "unknown-file");
  const titlePart = slug(title).slice(0, 80) || `finding-${idx + 1}`;
  return `aisle-nano:${filePart}:${titlePart}`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, "-")
      // Collapse before trimming: `-+$` rescans every interior dash run to the end (O(n²),
      // CodeQL alert 90); after collapsing, each end holds at most one dash. Same output.
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return undefined;
    out[k.toLowerCase()] = v;
  }
  return out;
}
