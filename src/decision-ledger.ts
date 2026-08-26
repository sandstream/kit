/**
 * kit — the decision ledger: require the artifact kit must not generate, and verify its shape.
 *
 * WHY THIS EXISTS. Four things have to stay readable however unreadable the generated code
 * becomes: invariants, traces, attack surface, and decisions. kit already owns the first three —
 * `.kit/standards.d` + ADR `kit-enforce` blocks, the hash-chained audit log, the signed scope and
 * exec-broker. The fourth had nothing. Yet once nobody reads the diff, the decisions are the
 * actual review surface: a long unattended run produces tens of thousands of lines nobody audits
 * and a few dozen choices that decide whether the result is right.
 *
 * THE SPLIT, WHICH IS THE WHOLE DESIGN.
 *
 *   - **kit must not generate the ledger.** Writing down what was decided, what was assumed and
 *     what it would have asked is model work, and the zero-LLM core does not do model work. The
 *     entries come from whoever ran the agent, through `kit decisions add`.
 *   - **kit requires it and verifies its SHAPE.** That an entry exists, carries the four facts,
 *     and parses — all deterministic, all checkable without reading a word of meaning.
 *   - **kit never gates on the CONTENT.** No scoring of whether a decision was good, no threshold
 *     on how convincing an assumption reads. The auditor separation exists precisely so nothing
 *     optimises for a clean report; a content score recreates that incentive on kit's side of the
 *     line. `parseLedger` therefore accepts a transparently thin entry, and a test pins that.
 *
 * Same shape as the two gates that came before it: `kit standards` fails on net-new findings
 * against a frozen baseline, `kit check`'s advisory baseline fails on new dependency debt. Both
 * gate existence and form, never a judgement about a given entry.
 *
 * WHY JSONL, AND WHY UNDER `.kit/`. The ledger is per-run and disposable — the durable artifact is
 * an ADR, which is what a reviewed decision becomes. Append-only lines survive an agent appending
 * mid-run without a read-modify-write race, and `.kit/` is already gitignored (`.kit/*` with the
 * `!.kit/shared/` exception), which is the right default for a per-run file. A repo that wants to
 * keep its ledgers can track the file explicitly; kit does not care either way.
 *
 * ONE DELIBERATE DIFFERENCE FROM `.kit-triage.jsonl`. That reader skips a torn line, because the
 * triage log is evidence that something happened and one damaged append loses one record. This
 * ledger IS the review surface, so an unreadable line is a hole in it and is reported as a
 * problem. A ledger that quietly drops what it cannot parse is the false green this file exists
 * to prevent.
 */

import { readFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Per-run decision ledger. Relative to the repo root. */
export const DECISION_LEDGER_FILE = ".kit/decisions.jsonl";

export const MIN_CONFIDENCE = 0;
export const MAX_CONFIDENCE = 1;

/**
 * One decision, in the form the issue's step 2 requires: what was decided, how sure, what was
 * assumed in the absence of an answer, and the question it would have asked had asking been free.
 * That last field is the one that carries the most: it names where the spec was silent.
 */
export interface DecisionEntry {
  /** Stable identity — the handle a review, and later a promotion to an ADR, refers to. */
  id: string;
  /** ISO-8601 timestamp of when the decision was made. */
  at: string;
  /** What was chosen. */
  decision: string;
  /** How sure the deciding party was, 0..1. Not a quality score — kit never reads it as one. */
  confidence: number;
  /** What was taken as true because nothing said otherwise. */
  assumed: string;
  /** The question it would have asked if asking had been free. */
  would_have_asked: string;
  /** Review state. Defaults to false; the gate on unreviewed entries is a later step. */
  reviewed: boolean;
}

/** A line kit could not accept, and why. Never a judgement about content. */
export interface LedgerProblem {
  /** 1-based line number in the ledger file. */
  line: number;
  message: string;
}

export interface LedgerSummary {
  total: number;
  unreviewed: number;
  /** Timestamp of the newest entry, or null for an empty ledger. */
  newest: string | null;
}

export interface ParsedLedger {
  entries: DecisionEntry[];
  problems: LedgerProblem[];
  /** Non-blank lines considered — the denominator in "2 of 3 entries are unreadable". */
  lines: number;
}

/** The three free-text facts every entry must carry, beyond id/at/confidence. */
const REQUIRED_TEXT = ["decision", "assumed", "would_have_asked"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read a ledger's text into entries plus the problems that stopped a line from becoming one.
 *
 * Pure and I/O-free so the rules can be tested without a filesystem, and so the CLI, the check
 * face and any future consumer all apply exactly one definition of "well-formed". An invalid line
 * yields a problem and NO entry; a duplicate id yields a problem AND the entry, because the line
 * is readable — what it is not is distinguishable from the one before it.
 */
export function parseLedger(text: string): ParsedLedger {
  const entries: DecisionEntry[] = [];
  const problems: LedgerProblem[] = [];
  const seen = new Set<string>();
  let lines = 0;

  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return;
    lines += 1;

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      problems.push({ line, message: "not valid JSON — the line cannot be read" });
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push({ line, message: "not a JSON object" });
      return;
    }

    const row = value as Record<string, unknown>;
    const faults: string[] = [];
    if (!isNonEmptyString(row.id)) faults.push("`id` must be a non-empty string");
    if (!isNonEmptyString(row.at) || !Number.isFinite(Date.parse(row.at as string))) {
      faults.push("`at` must be an ISO-8601 timestamp");
    }
    for (const field of REQUIRED_TEXT) {
      if (!isNonEmptyString(row[field])) faults.push(`\`${field}\` must be a non-empty string`);
    }
    if (
      typeof row.confidence !== "number" ||
      !Number.isFinite(row.confidence) ||
      row.confidence < MIN_CONFIDENCE ||
      row.confidence > MAX_CONFIDENCE
    ) {
      faults.push(
        `\`confidence\` must be a number between ${MIN_CONFIDENCE} and ${MAX_CONFIDENCE}`,
      );
    }
    if (row.reviewed !== undefined && typeof row.reviewed !== "boolean") {
      faults.push("`reviewed` must be true or false when present");
    }
    if (faults.length > 0) {
      problems.push({ line, message: faults.join("; ") });
      return;
    }

    const entry: DecisionEntry = {
      id: (row.id as string).trim(),
      at: row.at as string,
      decision: row.decision as string,
      confidence: row.confidence as number,
      assumed: row.assumed as string,
      would_have_asked: row.would_have_asked as string,
      reviewed: row.reviewed === true,
    };
    if (seen.has(entry.id)) {
      problems.push({ line, message: `duplicate id \`${entry.id}\`` });
    }
    seen.add(entry.id);
    entries.push(entry);
  });

  return { entries, problems, lines };
}

/** Build an entry. `now` and `id` are injected so the result is reproducible in a test. */
export function newEntry(
  input: { decision: string; confidence: number; assumed: string; wouldHaveAsked: string },
  now: Date,
  id: () => string,
): DecisionEntry {
  return {
    id: id(),
    at: now.toISOString(),
    decision: input.decision,
    confidence: input.confidence,
    assumed: input.assumed,
    would_have_asked: input.wouldHaveAsked,
    reviewed: false,
  };
}

/** One entry, one line — `JSON.stringify` escapes any embedded newline, so an append cannot
 *  smear two entries into one unreadable line. */
export function serialiseEntry(entry: DecisionEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

export function summarise(entries: DecisionEntry[]): LedgerSummary {
  let newest: string | null = null;
  for (const entry of entries) {
    if (newest === null || Date.parse(entry.at) > Date.parse(newest)) newest = entry.at;
  }
  return {
    total: entries.length,
    unreviewed: entries.filter((e) => !e.reviewed).length,
    newest,
  };
}

/**
 * Read the ledger from disk. `null` means the file does not exist — and the caller decides what
 * that means, because "nobody asked for a ledger" and "a governed run produced none" are different
 * states and collapsing them is how a gate goes quietly green. A read that fails for any other
 * reason THROWS: an unreadable ledger is not an empty one.
 */
export async function readLedger(root: string): Promise<ParsedLedger | null> {
  let text: string;
  try {
    text = await readFile(resolve(root, DECISION_LEDGER_FILE), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseLedger(text);
}

/** Append one entry, creating `.kit/` if this is the first decision of the run. */
export async function appendEntry(root: string, entry: DecisionEntry): Promise<string> {
  const path = resolve(root, DECISION_LEDGER_FILE);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, serialiseEntry(entry), "utf-8");
  return path;
}
