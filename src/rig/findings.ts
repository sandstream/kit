/**
 * Findings ingest for the rig (ADR-0007): one JSON object per line, written by a reviewer
 * that runs outside kit.
 *
 *   { "run": "r1", "config": "A", "file": "src/auth.ts", "line": 41,
 *     "claim": "token is not checked", "severity": "high",
 *     "model": "some-model", "model_version": "2026-10", "date": "2026-10-31" }
 *
 * kit never judges the claim text. It only needs the location to adjudicate (phase 2) and the
 * attribution to keep runs apart. A malformed row is reported with its line number and never
 * skipped silently; in strict mode one bad row refuses the whole file.
 */
import { relPath, RigManifestError } from "./manifest.js";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  run: string;
  config: string;
  file: string;
  line: number;
  claim: string;
  severity: Severity;
  model: string;
  model_version: string;
  date: string;
}

export interface RowError {
  line: number;
  message: string;
}

export interface IngestResult {
  findings: Finding[];
  errors: RowError[];
}

const KEYS = [
  "run",
  "config",
  "file",
  "line",
  "claim",
  "severity",
  "model",
  "model_version",
  "date",
];
const STRING_KEYS = ["run", "config", "claim", "model", "model_version"] as const;

/** The first problem with a row's scalar fields, or null. */
function scalarProblem(r: Record<string, unknown>): string | null {
  const extra = Object.keys(r).filter((k) => !KEYS.includes(k));
  if (extra.length > 0) return `unknown key(s) ${extra.sort().join(", ")}`;
  const blank = STRING_KEYS.find((k) => typeof r[k] !== "string" || (r[k] as string).trim() === "");
  if (blank) return `"${blank}" must be a non-empty string`;
  if (typeof r.line !== "number" || !Number.isInteger(r.line) || r.line < 1) {
    return `"line" must be a positive integer`;
  }
  if (!SEVERITIES.includes(r.severity as Severity)) {
    return `"severity" must be one of ${SEVERITIES.join(", ")}`;
  }
  const date = r.date;
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}/.test(date) ||
    Number.isNaN(Date.parse(date))
  ) {
    return `"date" must be an ISO date (YYYY-MM-DD…)`;
  }
  return null;
}

/** The row's file as a repository-relative `/` path, or the problem with it. */
function rowFile(raw: unknown): { file: string } | string {
  if (typeof raw !== "string" || raw.trim() === "") return `"file" must be a non-empty string`;
  try {
    return { file: relPath(raw, "file") };
  } catch (err) {
    return err instanceof RigManifestError ? err.message : `"file" is not a usable path`;
  }
}

/** Validate one parsed row. Returns the finding, or the first problem as a message. */
export function validateRow(row: unknown): Finding | string {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "row is not a JSON object";
  const r = row as Record<string, unknown>;
  const problem = scalarProblem(r);
  if (problem) return problem;
  const file = rowFile(r.file);
  if (typeof file === "string") return file;
  return {
    run: r.run as string,
    config: r.config as string,
    file: file.file,
    line: r.line as number,
    claim: r.claim as string,
    severity: r.severity as Severity,
    model: r.model as string,
    model_version: r.model_version as string,
    date: r.date as string,
  };
}

/** Parse JSONL text. Blank lines are allowed; every other line must be a valid finding. */
export function parseFindings(text: string): IngestResult {
  const findings: Finding[] = [];
  const errors: RowError[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.trim() === "") return;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      errors.push({ line: i + 1, message: "not valid JSON" });
      return;
    }
    const v = validateRow(row);
    if (typeof v === "string") errors.push({ line: i + 1, message: v });
    else findings.push(v);
  });
  return { findings, errors };
}

export class FindingsRefused extends Error {
  constructor(readonly errors: RowError[]) {
    super(
      `${errors.length} malformed row(s); first at line ${errors[0].line}: ${errors[0].message}`,
    );
  }
}

/** Parse, and in strict mode refuse the whole file when any row is malformed. */
export function ingestFindings(text: string, opts: { strict?: boolean } = {}): IngestResult {
  const result = parseFindings(text);
  if (opts.strict && result.errors.length > 0) throw new FindingsRefused(result.errors);
  return result;
}
