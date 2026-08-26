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
import { join, resolve } from "node:path";

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
      : [];

  return raw.map(normalizeTriageFinding);
}

export function parseAisleNanoSummaryJson(text: string): AisleNanoSummary {
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
  if (!parsed || typeof parsed !== "object") return {};

  const r = parsed as {
    timestamp?: string;
    target?: string;
    model?: string;
    per_file?: unknown[];
  };

  return {
    timestamp: str(r.timestamp),
    target: str(r.target),
    model: str(r.model),
    per_file: Array.isArray(r.per_file)
      ? r.per_file.map((entry) => {
          const e = (entry ?? {}) as { file?: string; severities?: Record<string, number> };
          return { file: str(e.file), severities: objectRecord(e.severities) };
        })
      : [],
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
): Promise<{ written: number }> {
  const triageText = await readFile(join(outputDir, "triage.json"), "utf-8");
  const triage = parseAisleNanoTriageJson(triageText);

  let summary: AisleNanoSummary | undefined;
  try {
    summary = parseAisleNanoSummaryJson(await readFile(join(outputDir, "summary.json"), "utf-8"));
  } catch (err) {
    if (!isMissingFile(err)) throw err;
  }

  return recordAisleNanoFindings(triage, cwd, { ...opts, summary });
}

function normalizeTriageFinding(raw: unknown): AisleNanoTriageFinding {
  if (!raw || typeof raw !== "object") return {};
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
  return {
    id: str(r.id),
    file: str(r.file),
    finding_title: str(r.finding_title),
    title: str(r.title),
    severity: str(r.severity),
    verdict: str(r.verdict),
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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
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
    if (typeof v === "number" && Number.isFinite(v)) out[k.toLowerCase()] = v;
  }
  return out;
}

function isMissingFile(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT",
  );
}
