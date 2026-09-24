/**
 * kit memory — local cross-machine sync (#reach).
 *
 * ~/.kit/memory.db is per-machine, so agent B never recalls agent A's decisions
 * across machines. `mergeDb` consolidates two stores but nothing invoked it.
 * This wires it to a concrete, LOCAL-FIRST transport (decided NO cloud ledger):
 * the user's own git repo or an encrypted backup file.
 *
 * Flow: machine A `kit memory backup <file>` -> commit/copy the encrypted blob
 * -> machine B `kit memory sync <file>` -> we decrypt to a temp DB (when the
 * input is an encrypted backup) and mergeDb into the local store. Incoming
 * session metadata is applied; messages are deduplicated with privacy repairs.
 * Task descendants advance; concurrent alternatives are retained, not
 * reconciled. `file_index` (per-machine transcript-index state) is never imported.
 *
 * A raw .db export is also accepted directly (no passphrase needed) for the
 * git-tracked-plaintext transport.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeDb, type MergeResult } from "./merge.js";
import { createProjectMapper, type MergeScopeOptions } from "./remap.js";
import { palShow } from "./pal.js";
import { scanDbForInjection, type ScanOccurrence } from "./scan.js";
import { pendingActionSyncId } from "./merge-actions.js";
import {
  isEncryptedBackup,
  isAsymmetricBackup,
  restoreEncrypted,
  restoreWithKey,
  loadMemoryKey,
} from "./backup.js";

export interface SyncOptions extends MergeScopeOptions {
  /** Passphrase for an encrypted backup export (KIT_MEMORY_PASSPHRASE). */
  passphrase?: string;
  /** Merge even if the incoming store has high-confidence injection findings. */
  allowUnsafe?: boolean;
}

/**
 * R7: an incoming store is untrusted — after merge its rows are replayed into the
 * agent's prompt (recall/decisions/PAL), so a poisoned entry is a delayed injection
 * vector. Scan the incoming DB BEFORE mergeDb and fail closed on any high-confidence
 * finding, so a poisoned pull can't silently land. Deterministic, read-only.
 * Override for a legitimate false positive with allowUnsafe / KIT_MEMORY_ALLOW_UNSAFE=1.
 * Fail CLOSED on a scan *error*: the incoming store is untrusted, so if we cannot
 * certify it clean we refuse rather than merge blind. (The scan itself is now
 * resilient to a partial/adversarial schema — see scanTarget — so a missing column
 * can no longer make the scan throw AND thereby bypass the gate, which was the R7
 * hole: drop `messages.cwd` → the rich SELECT threw → catch returned → the payload
 * in `messages.content` merged anyway. A throw here now means a genuinely unreadable DB.)
 */
function scanIncoming(
  dbPath: string,
  allowUnsafe: boolean,
  observe?: (db: DatabaseSync, occurrence: ScanOccurrence) => void,
): { label: string }[] {
  if (allowUnsafe || process.env.KIT_MEMORY_ALLOW_UNSAFE === "1") return [];
  let high: { label: string }[];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    high = scanDbForInjection(db, observe && ((occurrence) => observe(db, occurrence))).filter(
      (f) => f.confidence === "high",
    );
  } catch (e) {
    // Fail CLOSED — untrusted input we couldn't scan is not certified clean.
    throw new Error(
      `refusing to merge: could not scan the incoming memory store for injection (${(e as Error).message}). ` +
        "Inspect it, or set KIT_MEMORY_ALLOW_UNSAFE=1 to override.",
      { cause: e },
    );
  } finally {
    db.close();
  }
  return high;
}

function assertNoHighFindings(high: { label: string }[]): void {
  if (high.length) {
    const labels = [...new Set(high.map((f) => f.label))].join(", ");
    throw new Error(
      `refusing to merge: incoming memory has ${high.length} high-confidence injection pattern(s) [${labels}]. ` +
        "Inspect with `kit memory scan --injection`, or set KIT_MEMORY_ALLOW_UNSAFE=1 to override.",
    );
  }
}

/**
 * Merge another machine's memory export into `target`. Accepts either a raw
 * exported `.db` or an encrypted `kit memory backup` blob (decrypted to a temp
 * file first). Returns the MergeResult so the caller can report counts.
 */
function withExport<T>(exportPath: string, opts: SyncOptions, read: (path: string) => T): T {
  createProjectMapper(opts);
  if (!existsSync(exportPath)) {
    throw new Error(`export not found: ${exportPath}`);
  }

  if (!isEncryptedBackup(exportPath)) {
    // Plaintext .db (e.g. committed to the user's own repo) — merge directly.
    return read(exportPath);
  }

  const asymmetric = isAsymmetricBackup(exportPath);
  const privateKey = asymmetric ? loadMemoryKey() : null;
  if (asymmetric && !privateKey) {
    throw new Error(
      "this is a public-key (V3) backup — no local private key found; run `kit memory keygen` on this machine and restore its key, or copy ~/.kit/memory-key.json from a machine that has it",
    );
  }
  if (!asymmetric && !opts.passphrase) {
    throw new Error(
      "this looks like an encrypted backup — set KIT_MEMORY_PASSPHRASE to decrypt it",
    );
  }

  // Decrypt to a temp DB, merge, then remove the plaintext copy.
  const dir = mkdtempSync(join(tmpdir(), "kit-sync-"));
  const tmpDb = join(dir, "decrypted.db");
  try {
    if (asymmetric) restoreWithKey(privateKey!, exportPath, tmpDb, "import");
    else restoreEncrypted(opts.passphrase!, exportPath, tmpDb, "import");
    return read(tmpDb);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function syncFromExport(
  target: DatabaseSync,
  exportPath: string,
  opts: SyncOptions = {},
): MergeResult {
  return withExport(exportPath, opts, (path) => {
    assertNoHighFindings(scanIncoming(path, !!opts.allowUnsafe));
    return mergeDb(target, path, opts);
  });
}

type HistoryFinding = { label: string; kind?: "message" | "action"; id?: string };

/** Only explicit erasure can exempt a source finding, never projection demotion or dedup. */
function historyFinding(db: DatabaseSync, occurrence: ScanOccurrence): HistoryFinding {
  const result: HistoryFinding = { label: occurrence.label };
  const id = occurrence.id;
  if (typeof id !== "string" && typeof id !== "number") return result;
  try {
    let row: Record<string, unknown> | undefined;
    if (occurrence.table === "messages")
      row = db.prepare("SELECT uuid AS identity FROM messages WHERE id=?").get(id);
    else if (occurrence.table === "tool_uses")
      row = db.prepare("SELECT message_uuid AS identity FROM tool_uses WHERE id=?").get(id);
    else if (occurrence.table === "pal_revisions")
      row = db.prepare("SELECT sync_id AS identity FROM pal_revisions WHERE rev_id=?").get(id);
    else if (occurrence.table === "pending_actions") {
      const action = db.prepare("SELECT * FROM pending_actions WHERE id=?").get(id);
      if (action) row = { identity: pendingActionSyncId(action) };
    }
    if (typeof row?.identity === "string" && row.identity) {
      result.id = row.identity;
      result.kind =
        occurrence.table === "messages" || occurrence.table === "tool_uses" ? "message" : "action";
    }
  } catch {
    // Unidentifiable source findings remain blocking; no guessed erasure association.
  }
  return result;
}

function addMergeResult(result: MergeResult, current: MergeResult): void {
  for (const key of Object.keys(current) as (keyof MergeResult)[]) {
    const value = current[key];
    if (typeof value !== "number") continue;
    const previous = result[key];
    if (typeof previous === "number") Object.assign(result, { [key]: previous + value });
  }
  for (const [project, count] of Object.entries(current.projects))
    result.projects[project] = (result.projects[project] ?? 0) + count;
}

/** Import a complete transport history atomically, retaining every source's checks. */
export function syncFromExports(
  target: DatabaseSync,
  exports: Iterable<string>,
  opts: SyncOptions = {},
): MergeResult {
  let result: MergeResult | undefined;
  const differences = new Set<string>();
  const findings = new Map<string, HistoryFinding>();
  target.exec("SAVEPOINT kit_memory_history");
  try {
    for (const path of exports) {
      const current = withExport(path, opts, (source) => {
        scanIncoming(source, !!opts.allowUnsafe, (db, occurrence) => {
          if (occurrence.confidence !== "high") return;
          const finding = historyFinding(db, occurrence);
          findings.set(JSON.stringify(finding), finding);
        });
        return mergeDb(target, source, opts);
      });
      current.pendingDifferenceIds.forEach((id) => differences.add(id));
      if (!result) result = current;
      else addMergeResult(result, current);
    }
    if (!result) throw new Error("No memory snapshots found in Git history");
    const messages = target.prepare("SELECT 1 FROM memory_tombstones WHERE uuid=?");
    const actions = target.prepare("SELECT 1 FROM pal_tombstones WHERE sync_id=?");
    assertNoHighFindings(
      [...findings.values()].filter(
        (finding) =>
          !finding.id || !(finding.kind === "message" ? messages : actions).get(finding.id),
      ),
    );
    result.pendingDifferenceIds = [...differences].filter((id) => palShow(target, id)?.conflict);
    result.pendingStateDifferences = result.pendingDifferenceIds.length;
    target.exec("RELEASE kit_memory_history");
    return result;
  } catch (error) {
    target.exec("ROLLBACK TO kit_memory_history; RELEASE kit_memory_history");
    throw error;
  }
}
