/**
 * kit memory — PAL (Pending Action Ledger), folded into the memory store.
 *
 * PAL is the STRUCTURED, actionable layer on top of raw conversation memory:
 * "blocked-on-you" items that survive sessions and auto-close when their verify
 * check starts passing. It lives in the `pending_actions` table of the same
 * SQLite store.
 *
 * SECURITY: a verify is a DECLARATIVE, typed check (see `VerifyCheck`), executed
 * natively (fetch / fs) with a timeout. kit NEVER runs a shell, and never
 * interpolates a stored string into a command, so there is no arbitrary-command-
 * execution sink. HTTP checks still send requests; typed input is not a network
 * authorization boundary. Merged and legacy-imported checks are disabled until
 * explicitly configured locally. Unavailable evidence does not mutate task state and is
 * reported separately from a determinate failed check.
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  readActionHistory,
  recordLegacyAction,
  revisionTransaction,
  writeActionRevision,
} from "./pal-revisions.js";
import { withPalWrite } from "./pal-write-guard.js";
import { pendingActionSyncId } from "./merge-actions.js";
import { getProjectRecallRoots, registerProjectIdentity } from "./project.js";
import { deviceId } from "./device.js";
import { palDone } from "./pal-state.js";
import { createActionGrant, removeActionGrant } from "./pal-authority.js";
import { inspectAction } from "./pal-check-storage.js";
import type { PalClaimOwner } from "./pal-state-codec.js";
export { palDone, palSnooze, palRelease, palReopen } from "./pal-state.js";
export { palClaim, palRenew, palTakeover, type PalClaimOptions } from "./pal-claims.js";
export type { PalClaimOwner } from "./pal-state-codec.js";
export { palAutoVerify, type AutoVerifyResult } from "./pal-verify.js";
export { palConfigure } from "./pal-configure.js";
export { palForget } from "./pal-forget.js";
export {
  readActionHistory as palShow,
  resolveActionHistory as palResolve,
} from "./pal-revisions.js";
export { deviceId, deviceIdOverrideActive } from "./device.js";

/**
 * A declarative verify check. Fixed shapes only, executed natively by kit (no
 * shell, no arbitrary binary). Add a new shape here only if it can be run as a
 * pure data operation that cannot be coerced into command execution.
 */
export type VerifyCheck =
  | { type: "http-status"; url: string; expect: number }
  | { type: "file-exists"; path: string };

export interface PendingAction {
  id: string;
  status: string;
  title: string;
  detail: string | null;
  scope: string | null;
  kind: string;
  /** Legacy raw shell command from pre-1.4 stores. NEVER executed; kept only so
   *  `kit memory scan` can still find secrets leaked into old rows. */
  verify_cmd: string | null;
  /** Public JSON-encoded VerifyCheck; stored in verify_definition on current layouts. */
  verify_check: string | null;
  /** Opaque local approval lookup, not portable authority. Missing on old layouts. */
  verify_grant?: string | null;
  created_at: string | null;
  next_check: string | null;
  snooze_until: string | null;
  closed_at: string | null;
  verify_passes: number;
  /** Device where this item was created (v5+); NULL on legacy rows. */
  origin_device: string | null;
  /** Absolute creation path (v5+), also anchors original relative file checks. */
  origin_root: string | null;
  /** Agent/session that atomically claimed this open item (v6+); NULL = unclaimed. */
  claimed_by: string | null;
  /** When the claim was taken (v6+). */
  claimed_at: string | null;
  /** Explicit session owner; absent/null on historical claims with unknown ownership. */
  claim_owner?: PalClaimOwner | null;
  /** Portable identity; display ids may differ on another device. */
  sync_id?: string | null;
  origin_id?: string | null;
  /** Explicit local recall assignment. These aliases never travel implicitly. */
  recall_scope?: string | null;
  recall_device?: string | null;
  /** Fingerprint of the imported state, not permission to overwrite later local changes. */
  import_state?: string | null;
  /** Derived conflict flag; the stored row is not an adjudicated state when set. */
  state_conflict?: number;
}

/** Raw provenance for an imported action; prompt/terminal renderers sanitize it. */
export function pendingActionOrigin(action: PendingAction): string {
  if (!action.import_state) return "";
  return `[source: ${action.origin_device ?? "unknown device"} | ${action.origin_root ?? "unknown path"} | ${action.origin_id ?? action.id}]`;
}

export interface PalAddInput {
  title: string;
  detail?: string;
  scope?: string;
  kind?: "manual" | "auto";
  check?: VerifyCheck;
}

function newId(db: DatabaseSync): string {
  for (let i = 0; i < 100; i++) {
    const id = randomBytes(2).toString("hex"); // 4 hex chars, e.g. "ec95"
    if (!db.prepare("SELECT 1 FROM pending_actions WHERE id = ?").get(id)) return id;
  }
  throw new Error("could not allocate a unique pending-action id");
}

export function palAdd(db: DatabaseSync, input: PalAddInput): string {
  const id = newId(db);
  const kind = input.kind ?? (input.check ? "auto" : "manual");
  const verifyCheck = input.check ? JSON.stringify(input.check) : null;
  const originDevice = deviceId();
  const originRoot = process.cwd();
  const syncId = randomBytes(16).toString("hex");
  const grant =
    kind === "auto" && verifyCheck
      ? createActionGrant(db, {
          sync_id: syncId,
          origin_root: originRoot,
          verify_check: verifyCheck,
        })
      : null;
  try {
    writeActionRevision(db, id, () =>
      db
        .prepare(
          `INSERT INTO pending_actions
       (id, status, title, detail, scope, kind, verify_definition, origin_device, origin_root,
        sync_id, origin_id, verify_grant)
       VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.detail ?? null,
          input.scope ?? null,
          kind,
          verifyCheck,
          originDevice,
          originRoot,
          syncId,
          id,
          grant,
        ),
    );
  } catch (error) {
    removeActionGrant(db, grant);
    throw error;
  }
  registerProjectIdentity(db, originRoot);
  return id;
}

export interface PalListOptions {
  status?: string;
  /** All unresolved alternatives, independent of the display candidate's status. */
  conflictsOnly?: boolean;
  /** Restrict to this scope (including registered worktrees) plus NULL/global items. */
  scope?: string;
  /**
   * Include items from OTHER devices. Default false: only this device's items
   * (plus legacy NULL-origin rows) surface, so an ephemeral session's items never
   * nag your durable device. `kit memory pal list --all` sets this.
   */
  allDevices?: boolean;
  /** Inspect stored state without maintenance or creating a device identity. */
  readOnly?: boolean;
  /**
   * Reactivate expired snoozes before listing open work. Claims require explicit release or takeover.
   * Default true for normal
   * read-write surfaces. Legacy false also disables identity persistence;
   * new read-only callers should use readOnly instead.
   */
  reapStale?: boolean;
}

/** Shared project/device fence for inspection and local automatic reactivation. */
function actionScope(db: DatabaseSync, opts: PalListOptions) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  // Read-only status can open an older store that has not migrated yet.
  const portable = db
    .prepare("PRAGMA table_info(pending_actions)")
    .all()
    .some((column) => column.name === "recall_scope");
  const scopeColumn = portable ? "COALESCE(recall_scope, scope)" : "scope";
  const deviceColumn = portable ? "COALESCE(recall_device, origin_device)" : "origin_device";
  if (opts.scope !== undefined) {
    // Match paths literally across the same registered worktrees as transcript
    // recall. Basename aliases remain solely for legacy rows; NULL is global.
    const roots = isAbsolute(opts.scope) ? getProjectRecallRoots(opts.scope, db) : [opts.scope];
    const scopes = [...new Set(roots.flatMap((root) => [root, basename(root)]))];
    where.push(
      `(${scopeColumn} IN (${scopes.map(() => "?").join(", ")}) OR ${scopeColumn} IS NULL)`,
    );
    params.push(...scopes);
  }
  if (!opts.allDevices) {
    // Local legacy rows remain visible. Missing origin on an imported snapshot
    // is unknown, not evidence that the action belongs to this device.
    const legacy = portable
      ? `${deviceColumn} IS NULL AND import_state IS NULL`
      : `${deviceColumn} IS NULL`;
    where.push(`(${deviceColumn} = ? OR (${legacy}))`);
    params.push(deviceId({ persist: !opts.readOnly && opts.reapStale !== false }));
  }
  return { where: where.length ? where.join(" AND ") : "1", params };
}

const DUE_SNOOZE =
  "status='snoozed' AND (julianday(snooze_until) IS NULL OR julianday(snooze_until) <= julianday('now'))";

function reopenDue(db: DatabaseSync, scope?: string): string[] {
  // Even an all-device listing is not authority to reap an unassigned foreign task.
  const filter = actionScope(db, { scope });
  const eligible = `(${DUE_SNOOZE}) AND ${filter.where} AND state_conflict=0`;
  const rows = db.prepare(`SELECT id FROM pending_actions WHERE ${eligible}`).all(...filter.params);
  const reopened: string[] = [];
  for (const row of rows) {
    const id = String(row.id);
    if (readActionHistory(db, id)?.conflict) continue;
    const changed = writeActionRevision(db, id, () =>
      db
        .prepare(
          `UPDATE pending_actions SET status='open', claimed_by=NULL, claimed_at=NULL, claim_owner=NULL,
        snooze_until=NULL, closed_at=NULL, next_check=NULL, verify_passes=0
       WHERE id=? AND ${eligible}`,
        )
        .run(id, ...filter.params),
    );
    if (Number(changed.changes)) reopened.push(id);
  }
  return reopened;
}

export function palList(db: DatabaseSync, opts: PalListOptions = {}): PendingAction[] {
  const status = opts.status ?? "open";
  if (status === "open" && !opts.readOnly && opts.reapStale !== false) {
    reopenDue(db, opts.scope);
  }
  const filter = actionScope(db, opts);
  const hasConflicts = db
    .prepare("PRAGMA table_info(pending_actions)")
    .all()
    .some((column) => column.name === "state_conflict");
  // Old projections can hide equal-valued claimed heads. Include those candidates
  // and derive their conflict flag even when the caller cannot migrate the store.
  const conflict = hasConflicts ? "(state_conflict=1 OR status='claimed')" : "0";
  const stateFilter = opts.conflictsOnly
    ? conflict
    : status === "open"
      ? `(status=? OR ${conflict})`
      : "status=?";
  const rows = db
    .prepare(
      `SELECT * FROM pending_actions WHERE ${stateFilter} AND ${filter.where}
       ORDER BY created_at, id`,
    )
    .all(...(opts.conflictsOnly ? [] : [status]), ...filter.params) as unknown as PendingAction[];
  return rows
    .map((row) =>
      hasConflicts && row.status === "claimed"
        ? { ...row, state_conflict: Number(readActionHistory(db, row.id)!.conflict) }
        : row,
    )
    .filter((row) =>
      opts.conflictsOnly
        ? row.state_conflict === 1
        : row.status === status || (status === "open" && row.state_conflict === 1),
    )
    .sort((a, b) => (b.state_conflict ?? 0) - (a.state_conflict ?? 0))
    .map(inspectAction);
}

export interface PalPruneResult {
  closed: string[];
}

/**
 * Close open items created on THIS device whose origin project path no longer
 * exists — i.e. the work lived in an ephemeral / since-deleted directory, so the
 * reminder is dead. Only this device's items are pruned (we can't judge another
 * device's paths). Rows with no recorded origin_root are left untouched.
 */
export function palPrune(db: DatabaseSync): PalPruneResult {
  const rows = db
    .prepare(
      "SELECT id, origin_root FROM pending_actions WHERE status='open' AND origin_root IS NOT NULL AND origin_device = ? AND import_state IS NULL",
    )
    .all(deviceId()) as { id: string; origin_root: string }[];
  const closed: string[] = [];
  for (const r of rows) {
    if (!existsSync(r.origin_root) && palDone(db, r.id)) closed.push(r.id);
  }
  return { closed };
}

/** One scanner finding to track. `dedupKey` is stable per finding within its
 *  source (e.g. `category:name`), so re-scans map to the same ledger item. */
export interface SyncFinding {
  dedupKey: string;
  title: string;
  detail?: string;
}

export interface SyncFindingsResult {
  added: number;
  reopened: number;
  closed: string[];
  /** Claimed or contested findings retained until their owner releases or resolves them. */
  deferred?: string[];
}

/** Deterministic pal id for a finding: `${sourceTag}-${6 hex}`. The source tag
 *  prefix lets a per-source sync reconcile only its own items. */
export function findingPalId(sourceTag: string, dedupKey: string): string {
  const h = createHash("sha256").update(dedupKey).digest("hex").slice(0, 6);
  return `${sourceTag}-${h}`;
}

function scannerFindingId(db: DatabaseSync, source: string, key: string, device: string): string {
  const base = findingPalId(source, key);
  let id = base;
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = db
      .prepare("SELECT origin_device, kind, import_state FROM pending_actions WHERE id = ?")
      .get(id);
    if (
      !row ||
      (row.kind === "finding" &&
        !row.import_state &&
        (row.origin_device === device || row.origin_device === null))
    )
      return id;
    const suffix = createHash("sha256")
      .update(`${device}\x1f${attempt}`)
      .digest("hex")
      .slice(0, 16);
    id = `${base}-${suffix}`;
  }
  throw new Error("could not allocate an independent scanner finding id");
}

/**
 * Sync a scanner's CURRENT findings into the ledger — the "track" layer.
 *
 * Each finding becomes an open `kind='finding'` item (deterministic id, so a
 * re-scan is idempotent). An item that had cleared (closed) and now recurs is
 * REOPENED; an open item whose finding the scan no longer reports is auto-CLOSED.
 * Finding-presence IS the verify, so this needs no shell and no stored command —
 * same security posture as the rest of PAL.
 *
 * Reconciliation is fenced three ways so a sync never clears someone else's
 * blocker: by source-tag, by scope (and the scope is folded INTO the id, so two
 * repos sharing a finding category never collide on one row), and by
 * origin_device. The device fence is the important one: on a SHARED store the
 * finding id is identical across machines, so without it a scan on device B that
 * doesn't see device A's finding would auto-close A's open security item. A scan
 * now only auto-closes findings this device owns (or legacy NULL-origin rows); a
 * genuinely-cleared finding lingers until the OWNING device re-scans — fail-safe
 * (a stale reminder, never a silently-dropped blocker).
 */
export function palSyncFindings(
  db: DatabaseSync,
  sourceTag: string,
  findings: SyncFinding[],
  opts: { scope?: string } = {},
): SyncFindingsResult {
  const scope = opts.scope ?? null;
  const device = deviceId();
  // Fold scope into the id so the same finding in two different repos maps to two
  // distinct ledger rows (findingPalId alone is repo-independent).
  const idFor = (dedupKey: string) =>
    scannerFindingId(db, sourceTag, scope ? `${scope}\x1f${dedupKey}` : dedupKey, device);
  const currentIds = new Set<string>();
  let added = 0;
  let reopened = 0;
  const deferred = new Set<string>();

  for (const f of findings) {
    const id = idFor(f.dedupKey);
    currentIds.add(id);
    const existing = db.prepare("SELECT status FROM pending_actions WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    if (existing && (existing.status === "claimed" || readActionHistory(db, id)?.conflict)) {
      deferred.add(id);
      continue;
    }
    if (!existing) {
      writeActionRevision(db, id, () =>
        db
          .prepare(
            `INSERT INTO pending_actions (id, status, title, detail, scope, kind, origin_device, origin_root)
         VALUES (?, 'open', ?, ?, ?, 'finding', ?, ?)`,
          )
          .run(id, f.title, f.detail ?? null, scope, deviceId(), process.cwd()),
      );
      added++;
    } else if (existing.status === "closed") {
      // Creation provenance is immutable. Foreign/imported findings receive a
      // separate local scanner identity above, never a new owner on the old row.
      writeActionRevision(db, id, () =>
        db
          .prepare(
            "UPDATE pending_actions SET status='open', closed_at=NULL, title=?, detail=? WHERE id=?",
          )
          .run(f.title, f.detail ?? null, id),
      );
      reopened++;
    } else {
      // already open/snoozed — refresh the text so the reminder stays accurate
      writeActionRevision(db, id, () =>
        db
          .prepare("UPDATE pending_actions SET title=?, detail=? WHERE id=?")
          .run(f.title, f.detail ?? null, id),
      );
    }
  }

  // Auto-close findings of THIS source + scope + device that the scan no longer
  // reports. The origin_device fence stops a scan on one machine from clearing a
  // finding another machine is blocked on (shared store → identical ids); legacy
  // NULL-origin rows predate device coupling and are reconcilable by any device.
  const open = db
    .prepare(
      "SELECT id, status FROM pending_actions WHERE kind='finding' AND (status IN ('open','claimed') OR state_conflict=1) AND id LIKE ? AND scope IS ? AND (origin_device = ? OR origin_device IS NULL)",
    )
    .all(`${sourceTag}-%`, scope, deviceId()) as { id: string; status: string }[];
  const closed: string[] = [];
  for (const row of open) {
    if (row.status === "claimed" || readActionHistory(db, row.id)?.conflict) {
      deferred.add(row.id);
      continue;
    }
    if (!currentIds.has(row.id) && palDone(db, row.id)) closed.push(row.id);
  }

  return { added, reopened, closed, ...(deferred.size ? { deferred: [...deferred].sort() } : {}) };
}

// ── Migration from the legacy python PAL ledger ───────────────────────────────

export function getLegacyLedgerPath(): string {
  return process.env.KIT_PAL_LEDGER ?? join(homedir(), ".claude", "pal", "ledger.jsonl");
}

interface LegacyEntry {
  id?: string;
  ts?: string;
  status?: string;
  repo?: string;
  title?: string;
  why?: string;
  next_check?: string;
  pass_streak?: number;
  verify?: string;
}

/** Import the old `~/.claude/pal/ledger.jsonl` into pending_actions. Idempotent (by id). */
export function importLegacyLedger(
  db: DatabaseSync,
  path: string = getLegacyLedgerPath(),
): { imported: number } {
  if (!existsSync(path)) return { imported: 0 };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { imported: 0 };
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pending_actions
     (id, status, title, detail, scope, kind, verify_cmd, created_at, next_check, verify_passes, sync_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let imported = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: LegacyEntry;
    try {
      e = JSON.parse(t) as LegacyEntry;
    } catch {
      continue;
    }
    if (!e.id || !e.title) continue;
    const status = e.status === "done" ? "closed" : (e.status ?? "open");
    // SECURITY: a `verify` command read from a file is NOT operator-authored in
    // this session — the ledger path is overridable (KIT_PAL_LEDGER) and its
    // content is arbitrary. Import every legacy entry as `manual` with no
    // executable command, so palAutoVerify can never run a command that crossed
    // the file boundary. Re-authorise auto-verify by re-adding via `pal add`
    // (typed input). Invariant: kind='auto' + verify_cmd is only ever created
    // by palAdd. An existing item can also be explicitly configured via `pal configure`.
    const id = e.id;
    const title = e.title;
    const syncId = pendingActionSyncId({
      id,
      status,
      title,
      detail: e.why,
      scope: e.repo,
      created_at: e.ts,
      next_check: e.next_check,
    });
    const res = withPalWrite(db, { mode: "import", id }, () =>
      revisionTransaction(db, () => {
        if (db.prepare("SELECT 1 FROM pal_tombstones WHERE sync_id=?").get(syncId))
          return { changes: 0 };
        const result = insert.run(
          id,
          status,
          title,
          e.why ?? null,
          e.repo ?? null,
          "manual",
          null,
          e.ts ?? null,
          e.next_check ?? null,
          e.pass_streak ?? 0,
          syncId,
        );
        if (Number(result.changes)) recordLegacyAction(db, id);
        return result;
      }),
    );
    if (Number(res.changes) > 0) imported++;
  }
  return { imported };
}
