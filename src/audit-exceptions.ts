/**
 * Time-limited exceptions for `npm audit` findings that have no patched version.
 *
 * `npm audit` has no ignore list. When an advisory has `first_patched_version: null`, the only
 * choices are a red check on every pull request or a waiver. A waiver here is narrow on purpose:
 * it names one advisory id, carries a reason, and ends within 90 days. It never lowers the
 * severity threshold, and an advisory that is not named stays a failure.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AuditException {
  advisory: string;
  reason: string;
  /** Last day, inclusive, as YYYY-MM-DD in UTC. */
  expires: string;
}

export interface AuditFindings {
  /** High or critical packages that no active exception covers. */
  unexcused: string[];
  /** High or critical packages that an active exception covers, directly or through a dependency. */
  excused: string[];
  /** Advisories in the report whose exception has ended. */
  expired: string[];
}

export const AUDIT_EXCEPTIONS_FILE = "audit-exceptions.json";
const MAX_DAYS_AHEAD = 90;
const ADVISORY_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const DAY_MS = 86_400_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isHigh = (severity: unknown): boolean => severity === "high" || severity === "critical";

/** End of the given UTC day, or NaN when the text is not a calendar date. */
function endOfDay(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const start = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(start) ? NaN : start + DAY_MS - 1;
}

function parseOne(entry: unknown, index: number, now: Date): AuditException | string {
  const at = `audit exception ${index + 1}`;
  if (!isRecord(entry)) return `${at}: not an object`;
  const { advisory, reason, expires } = entry;
  if (typeof advisory !== "string" || !ADVISORY_ID.test(advisory)) {
    return `${at}: advisory must be a GHSA id such as GHSA-xxxx-xxxx-xxxx`;
  }
  if (typeof reason !== "string" || reason.trim() === "") return `${at}: reason is required`;
  const end = typeof expires === "string" ? endOfDay(expires) : NaN;
  if (Number.isNaN(end)) return `${at}: expires must be a date like 2026-12-31`;
  if (end - now.getTime() > MAX_DAYS_AHEAD * DAY_MS) {
    return `${at}: expires must be within ${MAX_DAYS_AHEAD} days, so no exception is permanent`;
  }
  return { advisory, reason: reason.trim(), expires: expires as string };
}

/** Validate the contents of `audit-exceptions.json`. Bad entries are dropped and named. */
export function parseAuditExceptions(
  raw: unknown,
  now: Date = new Date(),
): { exceptions: AuditException[]; problems: string[] } {
  if (!Array.isArray(raw)) {
    return { exceptions: [], problems: [`${AUDIT_EXCEPTIONS_FILE} must hold a list`] };
  }
  const exceptions: AuditException[] = [];
  const problems: string[] = [];
  raw.forEach((entry, i) => {
    const parsed = parseOne(entry, i, now);
    if (typeof parsed === "string") problems.push(parsed);
    else exceptions.push(parsed);
  });
  return { exceptions, problems };
}

interface Via {
  names: string[];
  advisories: { id: string; severity: unknown }[];
}

function advisoryId(url: unknown): string {
  return typeof url === "string" ? (url.split("/").pop() ?? "") : "";
}

function readVia(entry: unknown): Via {
  const via: Via = { names: [], advisories: [] };
  const list = isRecord(entry) && Array.isArray(entry.via) ? entry.via : [];
  for (const v of list) {
    if (typeof v === "string") via.names.push(v);
    else if (isRecord(v)) via.advisories.push({ id: advisoryId(v.url), severity: v.severity });
  }
  return via;
}

/**
 * Split the high and critical packages of an `npm audit --json` report into those an active
 * exception covers and those it does not. A package that only inherits another package's
 * advisory (a name in `via`) is covered when that package is.
 */
export function unexcusedFindings(
  audit: unknown,
  exceptions: AuditException[],
  now: Date = new Date(),
): AuditFindings {
  const map = isRecord(audit) && isRecord(audit.vulnerabilities) ? audit.vulnerabilities : {};
  const high = Object.keys(map).filter((name) => isRecord(map[name]) && isHigh(map[name].severity));
  const active = new Set(
    exceptions.filter((e) => endOfDay(e.expires) >= now.getTime()).map((e) => e.advisory),
  );
  const vias = new Map(high.map((name) => [name, readVia(map[name])]));

  // Least fixpoint: a package joins only when everything it rests on is covered, and it rests on
  // at least one thing. A cycle with no excepted advisory in it therefore never joins.
  const excused = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of high) {
      const via = vias.get(name) as Via;
      if (excused.has(name) || via.names.length + via.advisories.length === 0) continue;
      const namesOk = via.names.every((n) => !vias.has(n) || excused.has(n));
      const advisoriesOk = via.advisories.every((a) => !isHigh(a.severity) || active.has(a.id));
      if (namesOk && advisoriesOk) {
        excused.add(name);
        changed = true;
      }
    }
  }

  const seen = new Set([...vias.values()].flatMap((v) => v.advisories.map((a) => a.id)));
  const expired = exceptions
    .filter((e) => endOfDay(e.expires) < now.getTime() && seen.has(e.advisory))
    .map((e) => e.advisory);
  return {
    unexcused: high.filter((n) => !excused.has(n)).sort(),
    excused: [...excused].sort(),
    expired: [...new Set(expired)].sort(),
  };
}

/** The finding counts npm audit reports in `metadata.vulnerabilities`. */
function countedFindings(audit: unknown): number {
  const meta = isRecord(audit) && isRecord(audit.metadata) ? audit.metadata : {};
  const counts = isRecord(meta.vulnerabilities) ? meta.vulnerabilities : {};
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  return n(counts.high) + n(counts.critical);
}

async function loadExceptions(
  root: string,
  now: Date,
): Promise<{ exceptions: AuditException[]; problems: string[] } | null> {
  let text: string;
  try {
    text = await readFile(join(root, AUDIT_EXCEPTIONS_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    return parseAuditExceptions(JSON.parse(text), now);
  } catch {
    return { exceptions: [], problems: [`${AUDIT_EXCEPTIONS_FILE} is not valid JSON`] };
  }
}

/**
 * Decide whether the repo's exception file covers every high or critical finding of an
 * `npm audit --json` report. It covers them only when the report's package list explains all of
 * the findings it counts, so a report that is short on detail never turns green. `note` is text
 * for the check detail: what was excepted until when, or why the file did not help.
 */
export async function auditDecision(
  root: string,
  audit: unknown,
  now: Date = new Date(),
): Promise<{ covered: boolean; note: string }> {
  const loaded = await loadExceptions(root, now);
  if (!loaded) return { covered: false, note: "" };
  const notes = [...loaded.problems];
  const found = unexcusedFindings(audit, loaded.exceptions, now);
  if (found.expired.length > 0) notes.push(`exception expired: ${found.expired.join(", ")}`);
  const explained = found.excused.length + found.unexcused.length;
  const covered =
    found.unexcused.length === 0 &&
    found.excused.length > 0 &&
    explained === countedFindings(audit);
  if (!covered) return { covered, note: notes.join("; ") };
  const used = loaded.exceptions
    .filter((e) => endOfDay(e.expires) >= now.getTime())
    .map((e) => `${e.advisory} until ${e.expires}`);
  return { covered, note: `excepted: ${used.join(", ")}` };
}
