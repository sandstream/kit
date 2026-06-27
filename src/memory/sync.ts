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
import { isEncryptedBackup, restoreEncrypted } from "./backup.js";

export interface SyncOptions {
  /** Passphrase for an encrypted backup export (KIT_MEMORY_PASSPHRASE). */
  passphrase?: string;
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
    return mergeDb(target, exportPath);
  }

  if (!opts.passphrase) {
    throw new Error(
      "this looks like an encrypted backup — set KIT_MEMORY_PASSPHRASE (or pass --passphrase) to decrypt it",
    );
  }

  // Decrypt to a temp DB, merge, then remove the plaintext copy.
  const dir = mkdtempSync(join(tmpdir(), "kit-sync-"));
  const tmpDb = join(dir, "decrypted.db");
  try {
    restoreEncrypted(opts.passphrase, exportPath, tmpDb);
    return mergeDb(target, tmpDb);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
