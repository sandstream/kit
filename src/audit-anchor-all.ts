/**
 * The union view over every audit log this machine has sealed.
 *
 * `kit audit verify` answers for ONE working tree — correctly: `logAuditEvent`
 * resolves the log against the cwd it was handed, and a git worktree IS a distinct
 * working tree, so each one gets its own chain. On a machine running several (one
 * per agent session, which is what worktree-per-session harnesses produce) that
 * yields N independent green verdicts and no way to ask the question a reviewer
 * actually asks: what did the agents do to this repo today?
 *
 * The data to answer it was already on disk, unread. `~/.kit/audit-anchor.json`
 * keys the HMAC tip PER LOG PATH and lives in the home dir, shared by every working
 * tree on the machine. Measured on the machine that filed #470 it held 15 log paths
 * across 15 directories, and the only reader outside `audit-anchor.ts` looked up a
 * single path (`hints.ts`). This module iterates it.
 *
 * Why `missing` and `stalled` cannot share one outcome: most of those 15 paths are
 * short-lived test temp dirs, so a command that alarms on a vanished log is a command
 * nobody reads — and an unread report is the failure mode #470 is about, one level up.
 * A log that is GONE is expected attrition. A log that is STILL THERE with entries
 * past its seal is an unauthenticated tail, which is what deserves the attention.
 * Same evidence, two verdicts, so: two outcomes.
 *
 * The exit policy is deliberately the one `decideAnchorVerdict` already applies to a
 * single tree — an unsealed tail warns, and fails only under `--strict` /
 * `[governance.audit].require_anchor`. Diverging would mean the same log verifies
 * green in one command and red in the other, which is its own false verdict.
 */

import { verifyAuditChain } from "./audit.js";
import {
  decideAnchorVerdict,
  verifyAgainstAnchor,
  type AnchorRecord,
  type AnchorVerifyResult,
} from "./audit-anchor.js";
import { verifyExternalAnchor, type ExternalAnchorVerification } from "./audit-external.js";
import { sanitizeDisplayText } from "./display-text.js";

/**
 * Four outcomes, ranked by what a reader must do about them:
 *   verified — sealed prefix reproduces the tip and nothing is past the seal.
 *   stalled  — the log is there but the seal no longer covers it (unsealed tail,
 *              or a rotated anchor key): re-seal it where it lives.
 *   missing  — the log path is gone (temp dir, deleted clone). Attrition, not a finding.
 *   failed   — the chain or the seal does not reconcile, or it cannot be checked at
 *              all. Coverage that could not run counts here, never as verified.
 */
export type AnchoredLogOutcome = "verified" | "stalled" | "missing" | "failed";

/**
 * Machine-stable reason slug, so a `--json` consumer never has to parse prose.
 * Mirrors `AnchorVerifyStatus` where the cause comes from the anchor check, and adds
 * the causes that only exist when iterating paths kit did not just write.
 */
export type AnchoredLogDetail =
  | "verified"
  | "log-gone"
  | "unsealed-tail"
  | "anchor-key-changed"
  | "chain-broken"
  | "truncated"
  | "tip-mismatch"
  | "unparseable"
  | "key-unavailable"
  | "anchor-vanished"
  | "external-invalid"
  | "external-unverified"
  | "unreadable";

export interface AnchoredLogStatus {
  logPath: string;
  outcome: AnchoredLogOutcome;
  detail: AnchoredLogDetail;
  /** One human sentence: what is true, and what to do about it. */
  message: string;
  /** Entries currently in the log (absent when it could not be read). */
  entries?: number;
  /** Entries the anchor sealed. */
  sealed?: number;
  /** Entries appended past the seal. */
  unsealed?: number;
  /** ISO time the anchor was last advanced, straight off the record. */
  sealedAt?: string;
  externalVerification?: ExternalAnchorVerification;
}

export interface AnchoredLogsReport {
  results: AnchoredLogStatus[];
  counts: Record<AnchoredLogOutcome, number>;
  /**
   * Whether the command should exit 0. Strict mode fails stalled seals.
   * Required external verification also fails missing logs and an empty union.
   */
  ok: boolean;
  /** Echoed back so a `--json` reader can tell which policy produced `ok`. */
  strict: boolean;
  requireExternal?: boolean;
}

/** What a log path yielded: content, or why not. */
export type LogRead = { ok: true; content: string } | { ok: false; gone: boolean };

/** Injected so the classifier stays pure and the missing/unreadable split is testable. */
export type LogReader = (logPath: string) => Promise<LogRead>;

export interface AnchoredLogInput {
  logPath: string;
  record: AnchorRecord;
}

type AnchorInspection =
  | { kind: "unreadable"; gone: boolean }
  | { kind: "chain-broken"; chain: ReturnType<typeof verifyAuditChain> }
  | { kind: "anchor"; result: AnchorVerifyResult };

function inspectAnchor(read: LogRead, record: AnchorRecord, key: Buffer | null): AnchorInspection {
  if (!read.ok) return { kind: "unreadable", gone: read.gone };
  const chain = verifyAuditChain(read.content);
  if (!chain.ok) return { kind: "chain-broken", chain };
  return { kind: "anchor", result: verifyAgainstAnchor(read.content, record, key) };
}

type LogStatusContext = Omit<AnchoredLogStatus, "outcome" | "detail" | "message">;

function classifyIntactSeal(
  common: LogStatusContext,
  a: AnchorVerifyResult,
  requireExternal?: boolean,
): AnchoredLogStatus {
  const tail = a.newSinceAnchor ?? 0;
  const verdict = decideAnchorVerdict({
    result: a,
    strict: false,
    machineHasAnchors: true,
    requireExternal: requireExternal,
  });
  if (!verdict.ok) {
    return {
      ...common,
      outcome: "failed",
      detail:
        a.externalVerification?.status === "invalid"
          ? "external-invalid"
          : a.externalVerification?.status === "verified" && tail > 0
            ? "unsealed-tail"
            : "external-unverified",
      unsealed: tail,
      message: verdict.message,
    };
  }
  if (tail > 0) {
    return {
      ...common,
      outcome: "stalled",
      detail: "unsealed-tail",
      unsealed: tail,
      message: `${a.expected} sealed, ${tail} entr${
        tail === 1 ? "y" : "ies"
      } BEYOND the seal and unauthenticated — run 'kit audit anchor' in that tree to re-seal`,
    };
  }
  const entryLabel = a.expected === 1 ? "entry" : "entries";
  let externalNote = "";
  if (a.externalReceipt) {
    externalNote =
      a.externalVerification?.status === "verified"
        ? ` + verified external anchor (${sanitizeDisplayText(a.externalReceipt.authority)})`
        : "; external receipt UNVERIFIED";
  }
  return {
    ...common,
    outcome: "verified",
    detail: "verified",
    unsealed: 0,
    message: `HMAC anchor verified (${a.expected} sealed ${entryLabel})${externalNote}`,
  };
}

/**
 * Classify ONE anchored log. Pure given (record, read, key) so every branch —
 * including the ones that need a root-only or permission-denied filesystem to
 * reproduce for real — is reachable in a unit test.
 */
export function classifyAnchoredLog(
  logPath: string,
  record: AnchorRecord,
  read: LogRead,
  key: Buffer | null,
  opts: { requireExternal?: boolean; externalVerification?: ExternalAnchorVerification } = {},
): AnchoredLogStatus {
  return classifyInspection(logPath, record, inspectAnchor(read, record, key), opts);
}

function classifyUnreadableLog(
  base: LogStatusContext,
  gone: boolean,
  requireExternal?: boolean,
): AnchoredLogStatus {
  return gone
    ? {
        ...base,
        outcome: requireExternal ? "failed" : "missing",
        detail: "log-gone",
        message: requireExternal
          ? "External verification REQUIRED but the anchored log is missing. Preserve the anchor record and investigate."
          : `log no longer exists (sealed ${base.sealed} entr${
              base.sealed === 1 ? "y" : "ies"
            } at ${base.sealedAt}) — expected for a temp dir or a deleted clone; the anchor entry is pruned on the next seal`,
      }
    : {
        ...base,
        outcome: "failed",
        detail: "unreadable",
        message:
          "log exists but could not be read here, so its seal could not be checked — a chain that cannot be verified is unknown, not verified",
      };
}

function classifyInspection(
  logPath: string,
  record: AnchorRecord,
  inspection: AnchorInspection,
  opts: { requireExternal?: boolean; externalVerification?: ExternalAnchorVerification },
): AnchoredLogStatus {
  const sealedAt = record.updatedAt;
  const base = { logPath, sealed: record.count, sealedAt };

  if (inspection.kind === "unreadable") {
    return classifyUnreadableLog(base, inspection.gone, opts.requireExternal);
  }

  if (inspection.kind === "chain-broken") {
    const chain = inspection.chain;
    return {
      ...base,
      outcome: "failed",
      detail: "chain-broken",
      entries: chain.entries,
      message: `hash chain BROKEN at entry ${chain.brokenAt}: ${
        chain.reason ?? "unchained entry"
      } (${chain.entries} entries verified before the break)`,
    };
  }

  const a = { ...inspection.result, externalVerification: opts.externalVerification };
  const common = { ...base, entries: a.entries, externalVerification: opts.externalVerification };
  return classifySeal(common, a, opts.requireExternal);
}

function classifySeal(
  common: LogStatusContext,
  a: AnchorVerifyResult,
  requireExternal?: boolean,
): AnchoredLogStatus {
  switch (a.status) {
    case "anchored-ok":
      return classifyIntactSeal(common, a, requireExternal);
    // A rotated key invalidates every anchor it sealed, by design. That is a re-seal,
    // not a tamper, so it reads as stalled — with its own detail so the two reasons a
    // seal stopped covering a log never collapse into one line.
    case "anchor-key-changed":
      return {
        ...common,
        outcome: "stalled",
        detail: "anchor-key-changed",
        message:
          a.reason ??
          "the anchor key that sealed this log is not the current one (rotated/replaced) — re-run 'kit audit anchor' there",
      };
    case "key-unavailable":
      return {
        ...common,
        outcome: "failed",
        detail: "key-unavailable",
        message:
          "the anchor key is unreadable here, so no seal on this machine can be checked — failing closed rather than reporting a chain as verified",
      };
    // Defensive: the path came OUT of the anchor store, so a null anchor means the
    // record was removed underneath the iteration. Verified-by-absence is the exact
    // false green the anchor exists to prevent.
    case "no-anchor":
      return {
        ...common,
        outcome: "failed",
        detail: "anchor-vanished",
        message:
          "the anchor record for this path disappeared while it was being read — refusing to report an unanchored log as verified",
      };
    case "truncated":
    case "tip-mismatch":
    case "unparseable":
      return {
        ...common,
        outcome: "failed",
        detail: a.status,
        message: decideAnchorVerdict({ result: a, strict: true, machineHasAnchors: true }).message,
      };
  }
}

/**
 * Classify every anchored log the record knows about.
 *
 * Reads are sequential on purpose: the point of the command is a readable union
 * report over a handful of paths, and a bounded, ordered walk keeps the output stable
 * across runs (which is what makes it diffable in CI).
 */
export async function verifyAnchoredLogs(
  inputs: readonly AnchoredLogInput[],
  key: Buffer | null,
  read: LogReader,
  opts: { strict?: boolean; requireExternal?: boolean } = {},
): Promise<AnchoredLogsReport> {
  const strict = opts.strict === true;
  const results: AnchoredLogStatus[] = [];
  for (const { logPath, record } of inputs) {
    const inspection = inspectAnchor(await read(logPath), record, key);
    let externalVerification: ExternalAnchorVerification | undefined;
    if (
      record.external &&
      inspection.kind === "anchor" &&
      inspection.result.status === "anchored-ok"
    ) {
      externalVerification = await verifyExternalAnchor(logPath, record);
    }
    results.push(
      classifyInspection(logPath, record, inspection, {
        requireExternal: opts.requireExternal,
        externalVerification,
      }),
    );
  }
  const report = summarizeAnchoredLogs(results, strict || opts.requireExternal === true);
  return {
    ...report,
    strict,
    requireExternal: opts.requireExternal === true,
    ok: report.ok && (!opts.requireExternal || results.length > 0),
  };
}

/**
 * Fold per-path outcomes into the verdict. Exported separately so the exit policy is
 * one testable decision, the way `decideAnchorVerdict` is for a single tree.
 */
export function summarizeAnchoredLogs(
  results: readonly AnchoredLogStatus[],
  strict: boolean,
): AnchoredLogsReport {
  const counts: Record<AnchoredLogOutcome, number> = {
    verified: 0,
    stalled: 0,
    missing: 0,
    failed: 0,
  };
  for (const r of results) counts[r.outcome]++;
  return {
    results: [...results],
    counts,
    ok: counts.failed === 0 && (!strict || counts.stalled === 0),
    strict,
  };
}

/** Read a log for the union walk, splitting "gone" from "there but unreadable". */
export async function readLogForUnion(logPath: string): Promise<LogRead> {
  const { readFile } = await import("node:fs/promises");
  try {
    return { ok: true, content: await readFile(logPath, "utf-8") };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { ok: false, gone: code === "ENOENT" || code === "ENOTDIR" };
  }
}
