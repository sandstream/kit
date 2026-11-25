/**
 * `[[scan.allow]]` in `.kit.toml`: reviewed exceptions for `kit security scan-staged`.
 *
 * Three properties matter more than the exact format. A reason is required, so an entry is never a
 * silent ignore. An entry is narrow: one file and one finding label, never a directory or a
 * pattern. It lives in the repo, so a new exception shows up in review like code.
 */
import type { StagedHit } from "./scan-staged.js";
import {
  falsePositiveMarkSchema,
  type EvidencedSecret,
  type FindingEvidence,
} from "./finding-evidence.js";

export interface AllowEntry {
  path: string;
  match: string;
  reason: string;
  /** Optional: the masked preview shown in the block message, to cover one value only. */
  preview?: string;
  reviewed?: string;
}

export interface AllowProblem {
  index: number;
  message: string;
}

export interface AllowUse {
  entry: AllowEntry;
  file: string;
  count: number;
  evidence: FindingEvidence[];
}

export interface AllowStale {
  entry: AllowEntry;
  why: string;
}

const KNOWN = new Set(["path", "match", "reason", "preview", "reviewed"]);
/** A blob that Kit could not read cannot be allowed. */
const UNSCANNABLE = "unscannable";

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function badPath(path: string): string | undefined {
  if (/[*?[\]{}]/.test(path)) return "must name one file, not a pattern";
  if (/[\\/]$/.test(path) || path === "." || path === "./")
    return "must name one file, not a directory";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "must be relative to the repository";
  if (path.split(/[\\/]/).includes("..")) return "must stay inside the repository";
  return undefined;
}

function badMatch(match: string): string | undefined {
  if (match.startsWith(UNSCANNABLE)) return "cannot be allowed: kit could not read the staged file";
  if (/[*?[\]{}()|^$\\+]/.test(match)) return "must be one finding label, not a pattern";
  return undefined;
}

function entryProblem(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "must be a table";
  const entry = raw as Record<string, unknown>;
  const unknown = Object.keys(entry).find((k) => !KNOWN.has(k));
  if (unknown) return `unknown setting "${unknown}" (allowed: ${[...KNOWN].join(", ")})`;
  if (!isText(entry.path)) return 'missing "path": the one file the exception covers';
  const path = badPath(entry.path);
  if (path) return `"path" ${path}`;
  if (!isText(entry.match)) return 'missing "match": the finding label, for example "keyed-secret"';
  const match = badMatch(entry.match);
  if (match) return `"match" ${match}`;
  if (!falsePositiveMarkSchema.safeParse({ reason: entry.reason }).success) {
    return 'missing "reason": add reason = "why this match is harmless" (at least 8 characters)';
  }
  if (entry.preview !== undefined && !isText(entry.preview)) return '"preview" must be text';
  if (entry.reviewed !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.reviewed))) {
    return '"reviewed" must be a date like 2026-11-01';
  }
  return undefined;
}

/** The valid entries, and a message per broken one. Broken entries are never applied. */
export function parseScanAllow(raw: unknown): { entries: AllowEntry[]; problems: AllowProblem[] } {
  if (raw === undefined || raw === null) return { entries: [], problems: [] };
  if (!Array.isArray(raw)) {
    return {
      entries: [],
      problems: [{ index: 0, message: "[scan] allow must be a list of [[scan.allow]] tables" }],
    };
  }
  const entries: AllowEntry[] = [];
  const problems: AllowProblem[] = [];
  raw.forEach((item, i) => {
    const message = entryProblem(item);
    if (message)
      problems.push({ index: i + 1, message: `[[scan.allow]] entry ${i + 1}: ${message}` });
    else entries.push(item as AllowEntry);
  });
  return { entries, problems };
}

const same = (a: string, b: string): boolean => a.split("\\").join("/") === b.split("\\").join("/");

function covers(entry: AllowEntry, f: EvidencedSecret): boolean {
  const { file, pattern } = f.evidence;
  if (!same(entry.path, file) || entry.match !== pattern) return false;
  return entry.preview === undefined || entry.preview === f.preview;
}

/**
 * Remove the findings an entry covers, and say which entry covered what. An entry that covered
 * nothing is stale when its file is part of this commit or no longer exists. An entry for a file
 * that is simply not staged is not judged: this run never looked at that file.
 */
export function applyAllow(
  hits: StagedHit[],
  entries: AllowEntry[],
  staged: string[],
  exists: (path: string) => boolean,
): { hits: StagedHit[]; used: AllowUse[]; stale: AllowStale[] } {
  const matches = new Map<AllowEntry, Map<string, FindingEvidence[]>>();
  const remaining: StagedHit[] = [];
  for (const hit of hits) {
    const kept = hit.findings.filter((f) => {
      const entry = entries.find((e) => covers(e, f));
      if (!entry) return true;
      const perFile = matches.get(entry) ?? new Map<string, FindingEvidence[]>();
      const evidence = perFile.get(hit.file) ?? [];
      evidence.push(f.evidence);
      perFile.set(hit.file, evidence);
      matches.set(entry, perFile);
      return false;
    });
    if (kept.length > 0 || hit.gap) remaining.push({ ...hit, findings: kept });
  }
  const used = [...matches].flatMap(([entry, files]) =>
    [...files].map(([file, evidence]) => ({ entry, file, evidence, count: evidence.length })),
  );
  const stale = entries.flatMap((entry) => {
    if (matches.has(entry)) return [];
    if (!exists(entry.path)) return [{ entry, why: "its file no longer exists" }];
    const isStaged = staged.some((p) => same(p, entry.path));
    return isStaged ? [{ entry, why: "it matched nothing in this commit" }] : [];
  });
  return { hits: remaining, used, stale };
}
