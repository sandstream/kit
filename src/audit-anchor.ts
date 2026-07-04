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
 * the tip, and re-seal a forged log. Closing THAT gap requires an EXTERNAL
 * anchor the local principal cannot rewrite (an RFC3161 TSA or a remote
 * append-only log) - see the ExternalTimestampAnchor extension point below.
 *
 * The append path stays KEYLESS so a project-sandboxed agent (which cannot read
 * `~/.kit`) can still append audit entries; anchoring is layered on top and is
 * best-effort / fail-soft on the write path. A log that was never anchored
 * verifies as "legacy (unanchored)" - a warning, not a hard failure.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { secureFile } from "./utils/secure-perms.js";
import { reReadHexKey } from "./utils/key-file.js";

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

/**
 * Machine-local HMAC key, created once (0600). Create is atomic (flag "wx"):
 * on a lost create race the winner's key is re-read so all callers agree.
 * Mirrors elevation.ts:getElevationSigningKey. Creating the key is a WRITE to
 * `~/.kit`, so a project-sandboxed principal that cannot write there will throw
 * here - callers on the append path must treat that as "anchoring unavailable",
 * never as a hard error.
 */
export async function getAuditAnchorKey(dir?: string): Promise<Buffer> {
  const keyPath = anchorKeyPath(dir);
  try {
    const hex = (await readFile(keyPath, "utf-8")).trim();
    if (hex.length >= 64) return Buffer.from(hex, "hex");
  } catch {
    /* fall through to create */
  }
  const key = randomBytes(32);
  await mkdir(anchorDir(dir), { recursive: true });
  try {
    await writeFile(keyPath, key.toString("hex") + "\n", {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    secureFile(keyPath); // owner-only on Windows (NTFS ignores mode)
    return key;
  } catch {
    // Lost the create race. Re-read the winner's key WITH the same length guard
    // as the happy path (+ retry) so a mid-write read can never hand back a
    // short/empty key (which would later look like a tip-mismatch). #fix5
    return reReadHexKey(keyPath);
  }
}

/**
 * Read the anchor key WITHOUT creating it. Returns null when the key is absent
 * or unreadable (e.g. a sandboxed principal). Verify uses this so that a missing
 * key downgrades to "cannot check the anchor" rather than minting a fresh key.
 */
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
    let obj: { hash?: unknown };
    try {
      obj = JSON.parse(line) as { hash?: unknown };
    } catch {
      return null;
    }
    if (typeof obj.hash !== "string") return null;
    hashes.push(obj.hash);
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
    let obj: { hash?: unknown; kid?: unknown; sig?: unknown };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      return null;
    }
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
   * present only when sealed with `kit audit anchor --external`. This is what
   * closes the same-UID gap: a local principal who can read the 0600 key still
   * cannot forge a fresh external receipt. Absent ⇒ HMAC-only seal.
   */
  external?: ExternalAnchorReceipt;
}

type AnchorStore = Record<string, AnchorRecord>;

async function readStore(dir?: string): Promise<AnchorStore> {
  try {
    const raw = await readFile(anchorRecordPath(dir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as AnchorStore;
    return {};
  } catch {
    return {};
  }
}

/**
 * Persist the store, pruning entries whose log file no longer exists so the
 * record self-heals after temp/ephemeral logs disappear (also keeps it bounded).
 */
async function writeStore(store: AnchorStore, dir?: string): Promise<void> {
  const pruned: AnchorStore = {};
  for (const [logPath, rec] of Object.entries(store)) {
    try {
      await stat(logPath);
      pruned[logPath] = rec;
    } catch {
      // log file gone -> drop the stale anchor entry
    }
  }
  await mkdir(anchorDir(dir), { recursive: true });
  const recordPath = anchorRecordPath(dir);
  await writeFile(recordPath, JSON.stringify(pruned, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  secureFile(recordPath);
}

export async function readAnchorRecord(
  logPath: string,
  dir?: string,
): Promise<AnchorRecord | null> {
  const store = await readStore(dir);
  return store[logPath] ?? null;
}

/**
 * True when this machine has sealed ANY audit log. Used by `kit audit verify`
 * to fail closed: once anchoring is in use, a log that presents as unanchored
 * (e.g. a project config repointed `log_file` at a forged, never-anchored file)
 * is suspicious rather than benign-legacy. #fix2
 */
export async function hasAnyAnchoredLogs(dir?: string): Promise<boolean> {
  const store = await readStore(dir);
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
    const ext = resolveExternalAnchor();
    if (!ext) {
      throw new Error(
        "external anchoring requested but none configured — set KIT_EXTERNAL_ANCHOR_CMD",
      );
    }
    rec.external = await ext.anchor({ tip: rec.tip, count: rec.count, logPath });
  }
  const store = await readStore(dir);
  store[logPath] = rec;
  await writeStore(store, dir);
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
   * Require an EXTERNAL anchor receipt: `kit audit verify --require-external`. An
   * HMAC-only seal (no external receipt) then FAILS — for regulated enclaves that
   * must defeat even a same-UID forger. Independent of `strict`.
   */
  requireExternal?: boolean;
}

export interface AnchorVerdict {
  /** Whether the command should exit 0. */
  ok: boolean;
  level: "ok" | "warn" | "error";
  message: string;
}

/**
 * Map a raw anchor-verify result to a pass/fail verdict given the fail-closed
 * inputs. Pure + exported so the exact exit-code policy is unit-testable and the
 * three review attacks (path-repoint, forged tail, key-rotation) have a single
 * authoritative decision point. #fix2 #fix3 #fix4
 */
export function decideAnchorVerdict(input: AnchorVerdictInput): AnchorVerdict {
  const { result, strict, machineHasAnchors, requireExternal } = input;
  const failClosed = strict || machineHasAnchors;
  switch (result.status) {
    case "anchored-ok": {
      // External-anchor requirement: an HMAC-only seal can be forged by a same-UID
      // principal who reads the 0600 key; require-external refuses it. Checked
      // before the tail check so the strongest requirement wins.
      if (requireExternal && !result.externalReceipt) {
        return {
          ok: false,
          level: "error",
          message:
            "external anchor REQUIRED but this seal has none (HMAC-only) — re-seal with 'kit audit anchor --external'.",
        };
      }
      const tail = result.newSinceAnchor ?? 0;
      if (tail > 0) {
        // Unsealed tail = unauthenticated entries appended past the seal. Loud
        // by default; a hard failure under --strict / require_anchor. #fix3
        const msg = `HMAC anchor verified ${result.expected} sealed entries, but ${tail} entry(ies) BEYOND the seal are UNSEALED and UNAUTHENTICATED (anyone who can write the log can append keyless-rechained entries). Run 'kit audit anchor' to re-seal.`;
        return strict
          ? { ok: false, level: "error", message: msg }
          : { ok: true, level: "warn", message: msg };
      }
      const extNote = result.externalReceipt
        ? ` + external anchor (${result.externalReceipt.authority})`
        : "";
      return {
        ok: true,
        level: "ok",
        message: `HMAC anchor verified (${result.expected} sealed entries)${extNote}.`,
      };
    }
    case "no-anchor": {
      const msg = failClosed
        ? "log is NOT anchored but this machine has anchored logs (or anchoring is required); refusing to treat an unanchored log as verified. A repointed/forged log_file would land here."
        : "legacy (unanchored) audit log, keyless chain only. Run 'kit audit anchor' to seal it with the machine-local key.";
      return failClosed
        ? { ok: false, level: "error", message: msg }
        : { ok: true, level: "warn", message: msg };
    }
    case "key-unavailable": {
      const msg = failClosed
        ? "anchor present but the anchor key is unreadable here; cannot verify the HMAC seal (strict/require_anchor -> failing closed)."
        : "anchor present but the anchor key is unreadable here; cannot check the HMAC seal (keyless chain still intact).";
      return failClosed
        ? { ok: false, level: "error", message: msg }
        : { ok: true, level: "warn", message: msg };
    }
    case "anchor-key-changed":
      // Distinct from content tamper. Default warn (rotation needs a re-seal),
      // hard failure under strict so a CI gate cannot drift unnoticed. #fix4
      return {
        ok: !strict,
        level: strict ? "error" : "warn",
        message:
          result.reason ?? "anchor key changed (rotated/replaced); re-run 'kit audit anchor'.",
      };
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
    if (expectedTailHashes && expectedTailHashes.length > 0) {
      if (!seals || seals.length < expectedTailHashes.length) return;
      const onDisk = seals.slice(seals.length - expectedTailHashes.length).map((s) => s.hash);
      if (!onDisk.every((h, i) => h === expectedTailHashes[i])) return;
    }
    // CRITICAL: never silently re-seal over a prefix that no longer verifies.
    // Re-sealing a tampered / key-rotated log would erase a real alarm that
    // `kit audit verify` should have raised. Only advance when an existing
    // anchor's sealed prefix still verifies anchored-ok under the current key
    // (or when there is no anchor yet -> first seal). #fix4
    const existing = await readAnchorRecord(logPath, dir);
    if (existing) {
      const key = await tryReadAuditAnchorKey(dir);
      if (!key) return; // cannot verify the prefix -> do not re-seal
      const v = verifyAgainstAnchor(content, existing, key);
      if (v.status !== "anchored-ok") return; // preserve the alarm; do not re-seal
      // Bound the auto-seal to what THIS append added. A tail larger than the
      // caller's own writes is unattributed — do NOT absorb it into a green seal.
      if ((v.newSinceAnchor ?? 0) > expectedNewEntries) return;
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
    await anchorAuditLog(logPath, content, dir);
  } catch {
    // Best-effort: append must succeed even when anchoring cannot (sandbox /
    // unwritable home / unparseable log). The keyless chain still protects the
    // entry; verify reports the unanchored tail honestly.
  }
}

// ── Build 3 extension point: external timestamp / append anchor ──────────────
//
// The HMAC anchor above only resists a tamperer who CANNOT read the 0600 key.
// To close the same-UID gap an enclave needs an anchor the local principal
// cannot rewrite: an RFC3161 Time-Stamping Authority over the tip, or a remote
// append-only log. This is the documented, intentionally-unimplemented hook.
//
// kit does NOT ship a network TSA client (it would break the local-first /
// no-egress posture by default). An operator wires their own implementation and
// kit submits the tip after each seal. Fail-closed by contract: an enclave that
// requires external anchoring must treat a missing/failed external anchor as a
// verification failure, exactly like the air-gap provenance path.

export interface ExternalAnchorReceipt {
  /** Opaque proof bytes (e.g. an RFC3161 TimeStampToken), base64-encoded. */
  token: string;
  /** Authority / endpoint identifier, for audit. */
  authority: string;
  /** ISO-8601 time the external anchor attests. */
  timestamp: string;
}

export interface ExternalTimestampAnchor {
  /** Submit an anchor tip for external timestamping. Implementations MUST be
   *  fail-closed: reject (throw / reject the promise) rather than return a
   *  fabricated receipt when the authority is unreachable. */
  anchor(input: { tip: string; count: number; logPath: string }): Promise<ExternalAnchorReceipt>;
}

/**
 * A command-backed external anchor. kit ships NO network client (that would
 * break the local-first / no-egress default); instead the operator supplies a
 * command via `KIT_EXTERNAL_ANCHOR_CMD` that timestamps the tip however they
 * choose (an RFC3161 TSA submit, a post to a remote append-only log, …). The tip
 * + count + log path are passed as env (`KIT_ANCHOR_TIP`/`_COUNT`/`_LOGPATH`),
 * and the command MUST print a JSON receipt `{ token, authority?, timestamp? }`
 * on stdout. FAIL-CLOSED: a non-zero exit, a missing `token`, or unparseable
 * output throws — kit never fabricates a receipt.
 */
export function commandExternalAnchor(cmd: string): ExternalTimestampAnchor {
  return {
    async anchor({ tip, count, logPath }) {
      let out: string;
      try {
        out = execSync(cmd, {
          env: {
            ...process.env,
            KIT_ANCHOR_TIP: tip,
            KIT_ANCHOR_COUNT: String(count),
            KIT_ANCHOR_LOGPATH: logPath,
          },
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        });
      } catch (e) {
        throw new Error(`external anchor command failed: ${(e as Error).message}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        throw new Error("external anchor command did not emit a valid JSON receipt on stdout");
      }
      const r = (parsed ?? {}) as Partial<ExternalAnchorReceipt>;
      if (typeof r.token !== "string" || !r.token) {
        throw new Error("external anchor receipt is missing a non-empty `token`");
      }
      return {
        token: r.token,
        authority: typeof r.authority === "string" && r.authority ? r.authority : "command",
        timestamp:
          typeof r.timestamp === "string" && r.timestamp ? r.timestamp : new Date().toISOString(),
      };
    },
  };
}

/**
 * Resolve a configured external anchor, or null when none is wired (the default —
 * kit ships no network client by design). Today the only built-in binding is the
 * command transport (`KIT_EXTERNAL_ANCHOR_CMD`); the interface stays open for an
 * in-process implementation an enclave links itself.
 */
export function resolveExternalAnchor(): ExternalTimestampAnchor | null {
  const cmd = (process.env.KIT_EXTERNAL_ANCHOR_CMD ?? "").trim();
  return cmd ? commandExternalAnchor(cmd) : null;
}
