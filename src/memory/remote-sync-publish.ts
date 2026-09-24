import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadMemoryKey,
  memoryDbMatchesSnapshot,
  publicKeyString,
  restoreEncrypted,
  restoreWithKey,
} from "./backup.js";
import { getMemoryDbPath } from "./db.js";
import { gitMemoryCommand as git } from "./remote-sync-git.js";

interface PublishedSnapshotConfig {
  file: string;
  recipient?: string;
}

export function matchesPublishedSnapshot(
  cfg: PublishedSnapshotConfig,
  passphrase: string | undefined,
  dir: string,
): boolean {
  const blob = join(dir, cfg.file);
  if (!existsSync(blob)) return false;
  const key = cfg.recipient ? loadMemoryKey() : null;
  if (cfg.recipient && (!key || publicKeyString(key.x) !== cfg.recipient)) return false;
  if (!cfg.recipient && !passphrase) return false;
  const previous = join(dir, ".git", "kit-memory-previous.db");
  try {
    try {
      if (cfg.recipient) restoreWithKey(key!, blob, previous, "import");
      else restoreEncrypted(passphrase!, blob, previous, "import");
    } catch {
      // A changed passphrase or recipient cannot decrypt the previous blob.
      // Publish the current store with the newly configured key as before.
      return false;
    }
    return memoryDbMatchesSnapshot(getMemoryDbPath(), previous);
  } finally {
    rmSync(previous, { force: true });
  }
}

/** Give the throwaway clone a commit identity if the environment has none. */
export function ensureCommitIdentity(dir: string): void {
  const has = (key: string): boolean => {
    try {
      return !!git(["config", key], dir).trim();
    } catch {
      return false;
    }
  };
  if (!has("user.email")) git(["config", "user.email", "kit-memory-sync@localhost"], dir);
  if (!has("user.name")) git(["config", "user.name", "kit memory sync"], dir);
}
