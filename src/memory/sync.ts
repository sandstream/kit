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
 * input is an encrypted backup) and mergeDb into the local store. mergeDb is
 * last-write-wins on sessions and dedupes everything else by stable key; it does
 * NOT merge `file_index` (the per-machine transcript-index state), so a sync
 * never clobbers what this machine has already indexed.
 *
 * A raw .db export is also accepted directly (no passphrase needed) for the
 * git-tracked-plaintext transport.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeDb, type MergeResult } from "./merge.js";
import { scanDbForInjection } from "./scan.js";
import {
  isEncryptedBackup,
  isAsymmetricBackup,
  restoreEncrypted,
  restoreWithKey,
  loadMemoryKey,
} from "./backup.js";

export interface SyncOptions {
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
 * Fail-open only on a scan *error* (unknown/older schema) — mergeDb handles schema;
 * the gate's job is to block *detected* poison, not to reject every foreign store.
 */
function assertIncomingClean(dbPath: string, allowUnsafe: boolean): void {
  if (allowUnsafe || process.env.KIT_MEMORY_ALLOW_UNSAFE === "1") return;
  let high: { label: string }[] = [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    high = scanDbForInjection(db).filter((f) => f.confidence === "high");
  } catch {
    return; // can't scan (unknown schema) → let mergeDb decide; don't false-block
  } finally {
    db.close();
  }
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
export function syncFromExport(
  target: DatabaseSync,
  exportPath: string,
  opts: SyncOptions = {},
): MergeResult {
  if (!existsSync(exportPath)) {
    throw new Error(`export not found: ${exportPath}`);
  }

  if (!isEncryptedBackup(exportPath)) {
    // Plaintext .db (e.g. committed to the user's own repo) — merge directly.
    assertIncomingClean(exportPath, !!opts.allowUnsafe);
    return mergeDb(target, exportPath);
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
      "this looks like an encrypted backup — set KIT_MEMORY_PASSPHRASE (or pass --passphrase) to decrypt it",
    );
  }

  // Decrypt to a temp DB, merge, then remove the plaintext copy.
  const dir = mkdtempSync(join(tmpdir(), "kit-sync-"));
  const tmpDb = join(dir, "decrypted.db");
  try {
    if (asymmetric) restoreWithKey(privateKey!, exportPath, tmpDb);
    else restoreEncrypted(opts.passphrase!, exportPath, tmpDb);
    assertIncomingClean(tmpDb, !!opts.allowUnsafe);
    return mergeDb(target, tmpDb);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
