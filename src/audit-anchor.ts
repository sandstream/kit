/**
 * External HMAC anchor for the `.kit-audit.jsonl` hash chain.
 *
 * WHY THIS EXISTS (the gap it closes)
 * -----------------------------------
 * The per-line hash chain in audit.ts is tamper-EVIDENT but not tamper-PROOF:
 * the chain hashes are keyless and seed from a PUBLIC genesis constant
 * (`"0".repeat(64)`), so a writer who can rewrite `.kit-audit.jsonl` can also
 * recompute `prev` + `hash` for every line and produce a chain that
 * `verifyAuditChain` accepts. There is no key, no stored tip, and no stored
 * entry count, so a full rewrite (or a truncation/rollback) is invisible.
 *
 * This module adds a machine-local HMAC anchor kept OUTSIDE the project dir
 * (`~/.kit/audit-anchor.key`, 0600) plus an anchor record
 * (`~/.kit/audit-anchor.json`, 0600) holding, per log path, the latest HMAC
 * `tip` over the sealed prefix and the `count` of entries it covers.
 *
 *   - A tamperer who rewrites the log WITHOUT the key cannot recompute a tip
 *     that matches the stored one  -> `kit audit verify` reports tip-mismatch.
 *   - A tamperer who TRUNCATES or rolls back the log to fewer entries than the
 *     anchored count is caught by the count check -> reports truncated.
 *
 * HONEST THREAT BOUNDARY (read this before claiming anything)
 * -----------------------------------------------------------
 * This raises the bar from "anyone who can WRITE the log can forge it" to
 * "only someone who can READ the 0600 anchor key can forge it". It is NOT
 * tamper-proof against a same-UID local principal: an attacker running as the
 * same user can read `~/.kit/audit-anchor.key` AND the anchor record, recompute
 * the tip, and re-seal a forged log. External proof requires protected
 * verifier code, launch configuration, trust and current checkpoint state.
 * A timestamp alone does not detect rollback. An attacker who controls the
 * launcher can replace the delegated verifier. See ExternalTimestampAnchor.
 *
 * The append path stays KEYLESS so a project-sandboxed agent (which cannot read
 * `~/.kit`) can still append audit entries; anchoring is layered on top and is
 * best-effort / fail-soft on the write path. A log that was never anchored
 * verifies as "legacy (unanchored)" - a warning, not a hard failure.
 */
import { readFile } from "node:fs/promises";
import {
  readAnchorStore,
  findAnchorRecord,
  listAnchorRecords,
  storeAnchorRecord,
} from "./audit-anchor-store.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readProtectedAnchorKey } from "./audit-anchor-protected.js";
import { getAuditAnchorKeyAt } from "./audit-anchor-key.js";
import { issueExternalReceipt, type ExternalAnchorStatement } from "./audit-external.js";
import { sanitizeDisplayText } from "./display-text.js";

const ANCHOR_KEY_FILE = "audit-anchor.key";
const ANCHOR_RECORD_FILE = "audit-anchor.json";
const ANCHOR_ALGO = "hmac-sha256";
// Domain-separation seed so the anchor HMAC chain can never collide with any
// other HMAC use of the same key.
const ANCHOR_SEED = "kit-audit-anchor/v1";
// v3 seal folds ATTRIBUTION (kid/sig) into the tip alongside the hash, so
// stripping or rewriting the signer of a sealed entry changes the tip. Its own
// seed keeps a v3 tip from ever colliding with a v1/v2 (hash-only) tip.
const ANCHOR_SEED_V3 = "kit-audit-anchor/v3";
// Unit separator — cannot appear in a hex hash, an identity id, or base64 — so
// the (hash, kid, sig) fields can't be ambiguously concatenated.
const FIELD_SEP = "\x1f";

/** Resolve the directory that holds the anchor key + record (default ~/.kit). */
export function anchorDir(override?: string): string {
  if (override) return override;
  if (process.env.KIT_AUDIT_ANCHOR_DIR) return process.env.KIT_AUDIT_ANCHOR_DIR;
  return join(homedir(), ".kit");
}

export function anchorKeyPath(dir?: string): string {
  return join(anchorDir(dir), ANCHOR_KEY_FILE);
}

export function anchorRecordPath(dir?: string): string {
  return join(anchorDir(dir), ANCHOR_RECORD_FILE);
}

/** Read or create the machine key. A supplied guard enables protected creation and reads. */
export async function getAuditAnchorKey(dir?: string, beforeCreate?: () => void): Promise<Buffer> {
  return getAuditAnchorKeyAt(anchorKeyPath(dir), anchorDir(dir), beforeCreate);
}

/** Read a protected key without creating it. Unsafe files cause an error. */
export async function tryReadProtectedAuditAnchorKey(dir?: string): Promise<Buffer | null> {
  return readProtectedAnchorKey(anchorKeyPath(dir));
}

/** Read the key without creating it. Missing or unreadable files return null. */
export async function tryReadAuditAnchorKey(dir?: string): Promise<Buffer | null> {
  try {
    const hex = (await readFile(anchorKeyPath(dir), "utf-8")).trim();
    if (hex.length >= 64) return Buffer.from(hex, "hex");
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the per-line `hash` field from raw `.kit-audit.jsonl` content.
 * Returns null if any non-empty line is unparseable or lacks a string hash -
 * such a log cannot be anchored (the keyless chain check catches it first).
 */
export function lineHashes(content: string): string[] | null {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const hashes: string[] = [];
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    // `JSON.parse("null")` SUCCEEDS and yields null, so reading `.hash` off the result
    // threw a TypeError instead of returning the fail-closed null this function
    // promises. Every other malformed line (a bare number, a string, an array, a
    // truncated object) already returned null correctly — only the literal `null` line
    // escaped, because the property read sat outside the try. #unwired-coverage
    if (typeof obj !== "object" || obj === null) return null;
    const hash = (obj as { hash?: unknown }).hash;
    if (typeof hash !== "string") return null;
    hashes.push(hash);
  }
  return hashes;
}

/**
 * Fold an HMAC chain over the supplied line hashes and return the final tip
 * (hex). Pure: same key + hashes always yield the same tip. Only a holder of
 * the key can reproduce this value, which is what makes a key-less rewrite
 * detectable. (v1/v2 seal — hash only; kept for legacy anchor records.)
 */
export function computeAnchorTip(key: Buffer, hashes: string[]): string {
  let tip = createHmac("sha256", key).update(ANCHOR_SEED).digest("hex");
  for (const h of hashes) {
    tip = createHmac("sha256", key)
      .update(tip + "\n" + h)
      .digest("hex");
  }
  return tip;
}

/** A line's integrity hash plus its attribution (empty strings when keyless). */
export interface LineSeal {
  hash: string;
  kid: string;
  sig: string;
}

/**
 * Extract per-line hash + attribution from raw `.kit-audit.jsonl`. Returns null
 * if any non-empty line is unparseable or lacks a string hash. `kid`/`sig` are
 * "" for keyless (legacy) entries — folding them as empty means a keyless entry
 * has a stable seal, and ADDING a forged kid/sig to it later changes the tip.
 */
export function lineSeals(content: string): LineSeal[] | null {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const seals: LineSeal[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    // Same defect as lineHashes, and this is the LIVE extractor: `verifyAgainstAnchor`
    // calls it, so a single `null` line in .kit-audit.jsonl turned a documented
    // "unparseable" verdict into a thrown TypeError out of the verify path. A crash is
    // not a verdict.
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as { hash?: unknown; kid?: unknown; sig?: unknown };
    if (typeof obj.hash !== "string") return null;
    seals.push({
      hash: obj.hash,
      kid: typeof obj.kid === "string" ? obj.kid : "",
      sig: typeof obj.sig === "string" ? obj.sig : "",
    });
  }
  return seals;
}

/**
 * v3 seal: fold an HMAC chain over (hash, kid, sig) per line. This binds the
 * ATTRIBUTION into the external anchor, so a writer-only attacker who strips or
 * rewrites the signer of a SEALED entry — invisible to the keyless chain and to
 * the old hash-only anchor — now changes the tip and is caught as a tip-mismatch.
 * Pure.
 */
export function computeAnchorTipV3(key: Buffer, seals: LineSeal[]): string {
  let tip = createHmac("sha256", key).update(ANCHOR_SEED_V3).digest("hex");
  for (const s of seals) {
    tip = createHmac("sha256", key)
      .update(tip + "\n" + s.hash + FIELD_SEP + s.kid + FIELD_SEP + s.sig)
      .digest("hex");
  }
  return tip;
}

/** Recompute a record's tip with the algorithm matching its schema version. */
function tipForRecordVersion(key: Buffer, seals: LineSeal[], version: number | undefined): string {
  if ((version ?? 0) >= 3) return computeAnchorTipV3(key, seals);
  return computeAnchorTip(
    key,
    seals.map((s) => s.hash),
  );
}

// Domain-separated key-id label. The fingerprint is an HMAC of a FIXED label
// keyed by the anchor key, so it identifies the key (lets verify tell "the key
// rotated" apart from "the content was tampered") WITHOUT revealing key bytes.
const ANCHOR_KEY_FP_LABEL = "kit-anchor-key-fingerprint/v1";
/** Stable, non-reversible identifier for an anchor key. */
export function anchorKeyFingerprint(key: Buffer): string {
  return createHmac("sha256", key).update(ANCHOR_KEY_FP_LABEL).digest("hex").slice(0, 32);
}

/** Current schema version of the anchor record. v3 binds attribution (kid/sig). */
export const ANCHOR_RECORD_VERSION = 3;

export interface AnchorRecord {
  /** HMAC tip over the sealed prefix of `count` entries. */
  tip: string;
  /** Number of entries the tip covers. */
  count: number;
  /** Signature algorithm identifier. */
  algo: string;
  /** ISO-8601 time the anchor was last advanced. */
  updatedAt: string;
  /**
   * Non-reversible fingerprint of the key that sealed this record (v2+). Lets
   * verify report a key rotation distinctly from a content tamper. Absent on
   * legacy (v1) records, which fall back to the tip check.
   */
  keyFingerprint?: string;
  /** Anchor record schema version. */
  version?: number;
  /**
   * Receipt from an EXTERNAL timestamp anchor (RFC3161 TSA / append-only log),
   * present only when sealed with `kit audit anchor --external`.
   * The configured verifier must authenticate it against an independent checkpoint.
   * Verifier configuration and authority policy must remain outside attacker control.
   */
  external?: ExternalAnchorReceipt;
}

export async function readAnchorRecord(
  logPath: string,
  dir?: string,
): Promise<AnchorRecord | null> {
  return findAnchorRecord(await readAnchorStore(anchorRecordPath(dir)), logPath);
}

/**
 * Every log path this machine has sealed, with its record — the union view's oracle.
 *
 * The store keys the tip PER LOG PATH and lives in the home dir, so it already spans
 * every working tree on the machine; until `kit audit verify --all` nothing enumerated
 * it (see audit-anchor-all.ts and #470). Sorted so the report is stable across runs
 * and therefore diffable in CI.
 */
export async function listAnchoredLogs(
  dir?: string,
): Promise<Array<{ logPath: string; record: AnchorRecord }>> {
  const store = await readAnchorStore(anchorRecordPath(dir));
  return listAnchorRecords(store);
}

/**
 * True when this machine has sealed ANY audit log. Used by `kit audit verify`
 * to fail closed: once anchoring is in use, a log that presents as unanchored
 * (e.g. a project config repointed `log_file` at a forged, never-anchored file)
 * is suspicious rather than benign-legacy. #fix2
 */
export async function hasAnyAnchoredLogs(dir?: string): Promise<boolean> {
  const store = await readAnchorStore(anchorRecordPath(dir));
  return Object.keys(store).length > 0;
}

/**
 * Seal the current log: compute the HMAC tip over ALL current entries and
 * persist it as the anchor for `logPath`. Needs the key (creates it on first
 * use). Returns the written record. Throws if the content cannot be anchored
 * (unparseable / unchained) so the caller can surface it.
 */
export async function anchorAuditLog(
  logPath: string,
  content: string,
  dir?: string,
  opts: { external?: boolean } = {},
): Promise<AnchorRecord> {
  const { withAuditWriteLock } = await import("./audit-write-lock.js");
  return withAuditWriteLock(logPath, async (canonical) => {
    if ((await readFile(canonical, "utf8")) !== content) {
      throw new Error(
        "The audit log changed after the snapshot was read. Read it again before anchoring.",
      );
    }
    return sealAuditLog(canonical, content, dir, opts);
  });
}

async function sealAuditLog(
  logPath: string,
  content: string,
  dir?: string,
  opts: { external?: boolean } = {},
): Promise<AnchorRecord> {
  const seals = lineSeals(content);
  if (seals === null) {
    throw new Error("audit log is unparseable or unchained - cannot anchor");
  }
  const key = await getAuditAnchorKey(dir);
  const rec: AnchorRecord = {
    tip: computeAnchorTipV3(key, seals),
    count: seals.length,
    algo: ANCHOR_ALGO,
    updatedAt: new Date().toISOString(),
    keyFingerprint: anchorKeyFingerprint(key),
    version: ANCHOR_RECORD_VERSION,
  };
  // Optional EXTERNAL timestamp anchor. Fail-closed by contract: if the operator
  // asked for `--external` we refuse to write a seal unless a real receipt comes
  // back — a missing config or a failed/unreachable authority THROWS rather than
  // silently producing an HMAC-only seal that would later look externally sealed.
  if (opts.external) {
    rec.external = await issueExternalReceipt(logPath, rec);
  }
  await storeAnchorRecord(anchorRecordPath(dir), logPath, rec);
  return rec;
}

export type AnchorVerifyStatus =
  | "anchored-ok"
  | "no-anchor"
  | "key-unavailable"
  | "anchor-key-changed"
  | "tip-mismatch"
  | "truncated"
  | "unparseable";

export interface AnchorVerifyResult {
  status: AnchorVerifyStatus;
  /** Entries currently present in the log. */
  entries: number;
  /** Entries the anchor expects (when an anchor exists). */
  expected?: number;
  /** Entries appended since the last anchor (status "anchored-ok"). */
  newSinceAnchor?: number;
  /** The external-anchor receipt on the record, if any (for require-external checks). */
  externalReceipt?: ExternalAnchorReceipt;
  /** A trusted verifier must produce this result; receipt presence is insufficient. */
  externalVerification?: {
    status: "verified" | "invalid" | "unverified";
    message: string;
  };
  reason?: string;
}

/**
 * Verify a log body against its anchor record. Pure given (content, anchor,
 * key) so it is fully testable. Fail-closed semantics live in the caller; this
 * returns a precise status:
 *
 *   - no-anchor          : legacy/unanchored log - warn, not an error
 *   - key-unavailable    : anchor exists but the key cannot be read here - warn
 *   - anchor-key-changed : the current key is not the one that sealed the anchor
 *                          (rotation / lost key) - distinct from a content tamper
 *   - truncated          : fewer entries than the anchored count (rollback)
 *   - tip-mismatch       : the sealed prefix was rewritten under the SAME key
 *   - anchored-ok        : the sealed prefix reproduces the stored tip
 */
export function verifyAgainstAnchor(
  content: string,
  anchor: AnchorRecord | null,
  key: Buffer | null,
): AnchorVerifyResult {
  const seals = lineSeals(content);
  const entries = seals?.length ?? 0;
  if (!anchor) return { status: "no-anchor", entries };
  if (!key) return { status: "key-unavailable", entries, expected: anchor.count };
  // Key-rotation check FIRST so a changed key reports as a rotation, never as a
  // false content-tamper alarm. Only for v2+ records that carry a fingerprint;
  // legacy records fall through to the tip check (best effort). #fix4
  if (anchor.keyFingerprint && anchorKeyFingerprint(key) !== anchor.keyFingerprint) {
    return {
      status: "anchor-key-changed",
      entries,
      expected: anchor.count,
      reason:
        "the current anchor key differs from the one that sealed this log (rotated/replaced key); old anchors are invalid by design - re-run 'kit audit anchor'",
    };
  }
  if (seals === null) {
    return {
      status: "unparseable",
      entries,
      expected: anchor.count,
      reason: "log is unparseable - cannot reconcile with the anchor",
    };
  }
  if (seals.length < anchor.count) {
    return {
      status: "truncated",
      entries,
      expected: anchor.count,
      reason: `log has ${seals.length} entries but the anchor sealed ${anchor.count} (truncated/rolled back)`,
    };
  }
  // Recompute the sealed prefix with the algorithm that MATCHES the record's
  // version: a legacy (v≤2) anchor folds hash-only; a v3 anchor folds attribution
  // too, so a stripped/rewritten kid|sig on a sealed entry now fails to reproduce.
  const recomputed = tipForRecordVersion(key, seals.slice(0, anchor.count), anchor.version);
  const a = Buffer.from(recomputed, "hex");
  const b = Buffer.from(anchor.tip, "hex");
  const matches = a.length === b.length && timingSafeEqual(a, b);
  if (!matches) {
    return {
      status: "tip-mismatch",
      entries,
      expected: anchor.count,
      reason: "anchored prefix HMAC does not match - the log was rewritten without the anchor key",
    };
  }
  return {
    status: "anchored-ok",
    entries,
    expected: anchor.count,
    newSinceAnchor: entries - anchor.count,
    externalReceipt: anchor.external,
  };
}

export interface AnchorVerdictInput {
  result: AnchorVerifyResult;
  /**
   * Fail-closed mode: `kit audit verify --strict` OR
   * `[governance.audit].require_anchor = true`. In strict mode an unanchored
   * log, an unreadable key, and an unsealed tail are FAILURES, not warnings.
   */
  strict: boolean;
  /**
   * This machine has sealed at least one log. Even without --strict, a log that
   * presents as unanchored is then treated as a failure: a no-key writer must
   * not be able to repoint `log_file` at a forged, never-anchored file and have
   * it pass green. #fix2
   */
  machineHasAnchors: boolean;
  /**
   * Require a verified external anchor. Receipt presence does not establish authenticity.
   */
  requireExternal?: boolean;
}

export interface AnchorVerdict {
  /** Whether the command should exit 0. */
  ok: boolean;
  level: "ok" | "warn" | "error";
  message: string;
}

function unverifiedAnchorVerdict(fatal: boolean, message: string): AnchorVerdict {
  return { ok: !fatal, level: fatal ? "error" : "warn", message };
}

function externalProofFailure(result: AnchorVerifyResult, required: boolean): string | null {
  if (result.externalVerification?.status === "invalid") return result.externalVerification.message;
  if (!required) return null;
  if (!result.externalReceipt) {
    return "external anchor REQUIRED but this seal has none (HMAC-only). Re-seal with 'kit audit anchor --external'.";
  }
  if (result.externalVerification?.status !== "verified") {
    return (
      result.externalVerification?.message ??
      "external anchor UNVERIFIED: the receipt has not been authenticated by a trusted verifier."
    );
  }
  return null;
}

function intactAnchorVerdict(
  result: AnchorVerifyResult,
  strict: boolean,
  requireExternal?: boolean,
): AnchorVerdict {
  const externalFailure = externalProofFailure(result, requireExternal === true);
  if (externalFailure !== null) return unverifiedAnchorVerdict(true, externalFailure);
  const tail = result.newSinceAnchor ?? 0;
  if (tail > 0) {
    // Unsealed tail = unauthenticated entries appended past the seal. Loud
    // by default; a hard failure under --strict / require_anchor. #fix3
    const msg = `HMAC anchor verified ${result.expected} sealed entries, but ${tail} entry(ies) BEYOND the seal are UNSEALED and UNAUTHENTICATED (anyone who can write the log can append keyless-rechained entries). Run 'kit audit anchor' to re-seal.`;
    return unverifiedAnchorVerdict(strict || requireExternal === true, msg);
  }
  const externalUnverified =
    result.externalReceipt && result.externalVerification?.status !== "verified";
  const extNote = externalUnverified
    ? "; external receipt present but UNVERIFIED"
    : result.externalReceipt
      ? ` + verified external anchor (${sanitizeDisplayText(result.externalReceipt.authority)})`
      : "";
  return {
    ok: true,
    level: externalUnverified ? "warn" : "ok",
    message: `HMAC anchor verified (${result.expected} sealed entries)${extNote}.`,
  };
}

function missingAnchorVerdict(
  status: "no-anchor" | "key-unavailable",
  failClosed: boolean,
): AnchorVerdict {
  if (status === "no-anchor") {
    const msg = failClosed
      ? "log is NOT anchored but this machine has anchored logs (or anchoring is required); refusing to treat an unanchored log as verified. A repointed/forged log_file would land here."
      : "legacy (unanchored) audit log, keyless chain only. Run 'kit audit anchor' to seal it with the machine-local key.";
    return unverifiedAnchorVerdict(failClosed, msg);
  }
  const msg = failClosed
    ? "anchor present but the anchor key is unreadable here; cannot verify the HMAC seal (strict/require_anchor -> failing closed)."
    : "anchor present but the anchor key is unreadable here; cannot check the HMAC seal (keyless chain still intact).";
  return unverifiedAnchorVerdict(failClosed, msg);
}

/**
 * Map a raw anchor-verify result to a pass/fail verdict given the fail-closed
 * inputs. Pure + exported so the exact exit-code policy is unit-testable and the
 * three review attacks (path-repoint, forged tail, key-rotation) have a single
 * authoritative decision point. #fix2 #fix3 #fix4
 */
export function decideAnchorVerdict(input: AnchorVerdictInput): AnchorVerdict {
  const { result, strict, machineHasAnchors, requireExternal } = input;
  const requireCompleteSeal = strict || requireExternal === true;
  const failClosed = requireCompleteSeal || machineHasAnchors;
  switch (result.status) {
    case "anchored-ok":
      return intactAnchorVerdict(result, strict, requireExternal);
    case "no-anchor":
    case "key-unavailable":
      return missingAnchorVerdict(result.status, failClosed);
    case "anchor-key-changed":
      // Distinct from content tamper. Default warn (rotation needs a re-seal),
      // hard failure under strict so a CI gate cannot drift unnoticed. #fix4
      return unverifiedAnchorVerdict(
        requireCompleteSeal,
        result.reason ?? "anchor key changed (rotated/replaced); re-run 'kit audit anchor'.",
      );
    case "truncated":
    case "tip-mismatch":
    case "unparseable":
      return {
        ok: false,
        level: "error",
        message: result.reason ?? `HMAC anchor FAILED (${result.status}).`,
      };
  }
}

/**
 * Best-effort, fail-soft anchor advance for the append path. Extends the seal to
 * cover the entry (or entries) THIS append just wrote. NEVER throws and NEVER
 * blocks the append:
 *
 *   - disabled when KIT_AUDIT_ANCHOR=0 (the test suite sets this so incidental
 *     appends don't touch the real ~/.kit);
 *   - a sandboxed principal that cannot read/write ~/.kit simply does not
 *     anchor - the entry stays keyless-chain-protected and verifies later as
 *     "new unanchored entries since last anchor", which is honest, not a lie.
 *
 * `expectedNewEntries` (default 1) is how many entries the caller just appended.
 * The auto-advance seals AT MOST that many entries past the existing anchor: it
 * ratifies only what kit itself wrote in this call. A larger unsealed tail means
 * entries appeared past the seal that this append did NOT create — a writer-only
 * attacker's keyless-rechained forgeries, or a legit tail that accumulated while
 * anchoring was unavailable. Either way auto-advance REFUSES to fold them into a
 * fresh green seal (which would launder unauthenticated entries into "sealed" and
 * erase the unsealed-tail alarm `kit audit verify` must raise). Such a tail is
 * sealed only by an explicit, operator-driven `kit audit anchor`. #fix-tail
 *
 * `expectedTailHashes` (the chain hashes appendChained just wrote, newest last)
 * BINDS the seal to kit's own write. The size bound alone trusts whatever single
 * tail entry is on disk at read time; a concurrent writer that SUBSTITUTES that
 * entry in the append→read window would still satisfy `newSinceAnchor <= 1`. So
 * when the caller supplies the hashes, the on-disk tail must END with exactly
 * those hashes — otherwise the tail was rewritten by someone else and we refuse.
 */
export async function tryAdvanceAnchorOnAppend(
  logPath: string,
  dir?: string,
  opts: { expectedNewEntries?: number; expectedTailHashes?: string[] } = {},
): Promise<void> {
  if (process.env.KIT_AUDIT_ANCHOR === "0") return;
  try {
    const { withAuditWriteLock } = await import("./audit-write-lock.js");
    await withAuditWriteLock(logPath, (canonical) => advanceAnchor(canonical, dir, opts));
  } catch {
    // A failed anchor does not invalidate an otherwise successful local append.
  }
}

/** Hold the log lock across the append and its optional seal. */
export async function appendWithAuditAnchor(
  logPath: string,
  append: (canonical: string) => Promise<string>,
): Promise<void> {
  const { withAuditWriteLock } = await import("./audit-write-lock.js");
  await withAuditWriteLock(logPath, async (canonical) => {
    const hash = await append(canonical);
    await advanceAnchor(canonical, undefined, { expectedTailHashes: [hash] });
  });
}

function matchesAppendedTail(seals: LineSeal[] | null, expected?: string[]): boolean {
  if (!expected || expected.length === 0) return true;
  if (!seals || seals.length < expected.length) return false;
  const tail = seals.slice(seals.length - expected.length);
  return tail.every((seal, index) => seal.hash === expected[index]);
}

async function canExtendAnchor(
  content: string,
  existing: AnchorRecord,
  dir: string | undefined,
  maxNewEntries: number,
): Promise<boolean> {
  const key = await tryReadAuditAnchorKey(dir);
  if (!key) return false;
  const verified = verifyAgainstAnchor(content, existing, key);
  return verified.status === "anchored-ok" && (verified.newSinceAnchor ?? 0) <= maxNewEntries;
}

async function advanceAnchor(
  logPath: string,
  dir?: string,
  opts: { expectedNewEntries?: number; expectedTailHashes?: string[] } = {},
): Promise<void> {
  if (process.env.KIT_AUDIT_ANCHOR === "0") return;
  const expectedTailHashes = opts.expectedTailHashes;
  const expectedNewEntries = Math.max(
    1,
    opts.expectedNewEntries ?? expectedTailHashes?.length ?? 1,
  );
  try {
    const content = await readFile(logPath, "utf-8");
    const seals = lineSeals(content);
    // Bind to kit's own write: the on-disk tail must END with exactly the hashes
    // this append produced. If not, a concurrent writer rewrote the tail between
    // our append and this read — do NOT seal their bytes with the machine key.
    if (!matchesAppendedTail(seals, expectedTailHashes)) return;
    // CRITICAL: never silently re-seal over a prefix that no longer verifies.
    // Re-sealing a tampered / key-rotated log would erase a real alarm that
    // `kit audit verify` should have raised. Only advance when an existing
    // anchor's sealed prefix still verifies anchored-ok under the current key
    // (or when there is no anchor yet -> first seal). #fix4
    const existing = await readAnchorRecord(logPath, dir);
    if (existing) {
      // Preserve invalid prefixes and tails larger than this append's own writes.
      if (!(await canExtendAnchor(content, existing, dir, expectedNewEntries))) return;
    } else {
      // FIRST seal (no anchor yet) is bounded the SAME way: auto-anchor a log only
      // when it is as small as this append's own writes. A pre-existing multi-entry
      // UNANCHORED log — planted keyless forgeries, or a legit tail from when
      // anchoring was unavailable — must NOT be auto-sealed on the next append: that
      // would launder unauthenticated history into a green tip BEFORE `kit audit
      // verify` (whose no-anchor guard would otherwise catch it) ever runs. Such a
      // log is sealed only by an explicit, operator-driven `kit audit anchor`.
      const total = seals?.length ?? 0;
      if (total > expectedNewEntries) return;
      if (total === 0) return; // nothing (or unparseable) to seal
    }
    await sealAuditLog(logPath, content, dir);
  } catch {
    // Best-effort: append must succeed even when anchoring cannot (sandbox /
    // unwritable home / unparseable log). The keyless chain still protects the
    // entry; verify reports the unanchored tail honestly.
  }
}

// External authority contract.
// The operator provides issuance and verification commands; Kit adds no network client.
// Required verification needs both authenticated statement binding and a current checkpoint.
// Protect the verifier, launcher, authority trust and checkpoint from the audited principal.
// A timestamp alone cannot detect restoration of an older complete history.

export interface ExternalAnchorReceipt {
  /** Opaque proof bytes (e.g. an RFC3161 TimeStampToken), base64-encoded. */
  token: string;
  /** Authority / endpoint identifier, for audit. */
  authority: string;
  /** ISO-8601 time the external anchor attests. */
  timestamp: string;
  /** Versioned statement whose bytes the configured authority authenticates. */
  statement?: ExternalAnchorStatement;
}

export interface ExternalTimestampAnchor {
  /** Submit an anchor tip for external timestamping. Implementations MUST be
   *  fail-closed: reject (throw / reject the promise) rather than return a
   *  fabricated receipt when the authority is unreachable. */
  anchor(input: {
    tip: string;
    count: number;
    logPath: string;
    statement?: ExternalAnchorStatement;
  }): Promise<ExternalAnchorReceipt>;
}

// Keep the existing transport API available from its original module.
export { commandExternalAnchor, resolveExternalAnchor } from "./audit-external.js";
