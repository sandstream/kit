/**
 * Findings ingest for the rig (ADR-0007): one JSON object per line, written by a reviewer
 * that runs outside kit. Each run reviews one target, a planted defect or a clean control
 * from the manifest, and is attributed to a config (the prompt or policy variant) and a model.
 *
 *   { "run": "r1", "config": "A", "target": "d1", "file": "src/auth.ts", "line": 41,
 *     "claim": "token is not checked", "severity": "high",
 *     "model": "some-model", "model_version": "2026-10", "date": "2026-10-31" }
 *
 * A run that found nothing still has to be counted (a clean control with no finding is the
 * result that matters), so it is written as one row with `"none": true` and no location:
 *
 *   { "run": "r2", "config": "A", "target": "c1", "none": true,
 *     "model": "some-model", "model_version": "2026-10", "date": "2026-10-31" }
 *
 * A run that did not complete (the reviewer crashed, timed out or refused the target) is written
 * as one row with `"failed"` naming why, and no location. It is counted as a review that did not
 * happen: a defect it should have caught is not caught, and a control is not called clean.
 *
 *   { "run": "r3", "config": "A", "target": "d2", "failed": "refused",
 *     "model": "some-model", "model_version": "2026-10", "date": "2026-10-31" }
 *
 * One run of one target is either failed or reviewed: a row that contradicts an earlier one for
 * the same (config, run, target) is reported as malformed.
 *
 * Any row may carry an optional `"model_digest"`: what the caller says identifies the reviewer's
 * weights, as `<scheme>:<value>` (a content hash such as `sha256:<64 hex>`, or a provider snapshot
 * id such as `snapshot:<id>`). kit checks its shape and records it; it never computes, verifies or
 * adjudicates on it (ADR-0007). It lets a report tell "same label, different weights" apart. One
 * run of one target declared with two digests is reported as malformed.
 *
 * kit never judges the claim text. It only needs the location to adjudicate (phase 2) and the
 * attribution to keep runs apart. A malformed row is reported with its line number and never
 * skipped silently; in strict mode one bad row refuses the whole file.
 */
import { relPath, RigManifestError } from "./manifest.js";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Who reviewed what: present on every row, with or without a finding. */
export interface RunMark {
  run: string;
  config: string;
  target: string;
  model: string;
  model_version: string;
  date: string;
  /** Why the run did not complete, from a `"failed"` row. Absent for a completed review. */
  failed?: string;
  /** The caller's declared identity of the model's weights. Recorded, never verified. */
  model_digest?: string;
}

export interface Finding extends RunMark {
  file: string;
  line: number;
  claim: string;
  severity: Severity;
}

export interface RowError {
  line: number;
  message: string;
}

export interface IngestResult {
  findings: Finding[];
  /** Every run seen, with or without findings, one entry per (config, run, target). */
  runs: RunMark[];
  errors: RowError[];
}

const MARK_KEYS = ["run", "config", "target", "model", "model_version", "date", "model_digest"];
const FINDING_KEYS = [...MARK_KEYS, "file", "line", "claim", "severity"];
const NONE_KEYS = [...MARK_KEYS, "none"];
const FAILED_KEYS = [...MARK_KEYS, "failed"];
const MARK_STRINGS = ["run", "config", "target", "model", "model_version"] as const;

function unknownKeys(r: Record<string, unknown>, allowed: string[]): string | null {
  const extra = Object.keys(r).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `unknown key(s) ${extra.sort().join(", ")}` : null;
}

/** `<scheme>:<value>`, no whitespace, bounded. A hash scheme also fixes the hex length. */
const DIGEST_SHAPE = /^[a-z0-9][a-z0-9.-]{0,31}:[A-Za-z0-9._:/@+=-]{1,200}$/;
const HASH_HEX: Record<string, number> = { sha256: 64, sha384: 96, sha512: 128 };

/** The problem with an optional `model_digest`, or null. Shape only: kit cannot verify it. */
function digestProblem(d: unknown): string | null {
  if (d === undefined) return null;
  const why = `"model_digest" must be "<scheme>:<value>" (e.g. sha256:<64 hex> or snapshot:<id>)`;
  if (typeof d !== "string" || !DIGEST_SHAPE.test(d)) return why;
  const [scheme, value] = [d.slice(0, d.indexOf(":")), d.slice(d.indexOf(":") + 1)];
  const hex = HASH_HEX[scheme];
  return hex === undefined || new RegExp(`^[0-9a-f]{${hex}}$`).test(value) ? null : why;
}

/** The first problem with the attribution fields every row carries, or null. */
function markProblem(r: Record<string, unknown>): string | null {
  const blank = MARK_STRINGS.find(
    (k) => typeof r[k] !== "string" || (r[k] as string).trim() === "",
  );
  if (blank) return `"${blank}" must be a non-empty string`;
  const digest = digestProblem(r.model_digest);
  if (digest) return digest;
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

/** The first problem with a finding's own fields, or null. */
function findingProblem(r: Record<string, unknown>): string | null {
  if (typeof r.claim !== "string" || r.claim.trim() === "")
    return `"claim" must be a non-empty string`;
  if (typeof r.line !== "number" || !Number.isInteger(r.line) || r.line < 1) {
    return `"line" must be a positive integer`;
  }
  if (!SEVERITIES.includes(r.severity as Severity)) {
    return `"severity" must be one of ${SEVERITIES.join(", ")}`;
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

function markOf(r: Record<string, unknown>): RunMark {
  const mark: RunMark = {
    run: r.run as string,
    config: r.config as string,
    target: r.target as string,
    model: r.model as string,
    model_version: r.model_version as string,
    date: r.date as string,
  };
  if (typeof r.failed === "string") mark.failed = r.failed;
  if (typeof r.model_digest === "string") mark.model_digest = r.model_digest;
  return mark;
}

/** The keys a row may carry, by its kind: a finding, a `"none"` row or a `"failed"` row. */
function allowedKeys(r: Record<string, unknown>): string[] | string {
  if (r.none !== undefined && r.failed !== undefined)
    return `a row is "none" or "failed", not both`;
  if (r.none !== undefined) return r.none === true ? NONE_KEYS : `"none" must be true when present`;
  if (r.failed === undefined) return FINDING_KEYS;
  const ok = typeof r.failed === "string" && r.failed.trim() !== "";
  return ok
    ? FAILED_KEYS
    : `"failed" must be a non-empty string naming why the run did not complete`;
}

/**
 * Validate one parsed row. Returns a finding, a bare run mark for a `"none": true` or `"failed"`
 * row, or the first problem as a message.
 */
export function validateRow(row: unknown): Finding | RunMark | string {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "row is not a JSON object";
  const r = row as Record<string, unknown>;
  const allowed = allowedKeys(r);
  if (typeof allowed === "string") return allowed;
  const bare = allowed !== FINDING_KEYS;
  const problem = unknownKeys(r, allowed) ?? markProblem(r) ?? (bare ? null : findingProblem(r));
  if (problem) return problem;
  if (bare) return markOf(r);
  const file = rowFile(r.file);
  if (typeof file === "string") return file;
  return {
    ...markOf(r),
    file: file.file,
    line: r.line as number,
    claim: r.claim as string,
    severity: r.severity as Severity,
  };
}

/** The key that identifies one run of one config on one target. */
export function runKey(m: Pick<RunMark, "config" | "run" | "target">): string {
  return JSON.stringify([m.config, m.run, m.target]);
}

/** Why a row contradicts the earlier row for the same run of the same target, or null. */
function contradiction(seen: RunMark | undefined, row: RunMark): string | null {
  if (seen && seen.model_digest !== row.model_digest) {
    return `run ${row.run} of config ${row.config} on ${row.target} is already recorded with model_digest ${
      seen.model_digest ?? "(none)"
    }; one run of a target is one instrument`;
  }
  if (!seen || (seen.failed === undefined) === (row.failed === undefined)) return null;
  return `run ${row.run} of config ${row.config} on ${row.target} is already recorded as ${
    seen.failed === undefined ? "reviewed" : "failed"
  }; one run of a target is either failed or reviewed`;
}

/** Parse JSONL text. Blank lines are allowed; every other line must be a valid row. */
export function parseFindings(text: string): IngestResult {
  const findings: Finding[] = [];
  const runs = new Map<string, RunMark>();
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
    const seen = typeof v === "string" ? undefined : runs.get(runKey(v));
    const problem = typeof v === "string" ? v : contradiction(seen, v);
    if (problem) {
      errors.push({ line: i + 1, message: problem });
      return;
    }
    const mark = v as Finding | RunMark;
    if ("file" in mark) findings.push(mark);
    if (!seen) runs.set(runKey(mark), markOf({ ...mark }));
  });
  return { findings, runs: [...runs.values()], errors };
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
