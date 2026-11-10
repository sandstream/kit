import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  loadMemoryKey,
  memoryDbMatchesSnapshot,
  publicKeyString,
  restoreEncrypted,
  restoreWithKey,
} from "./backup.js";
import { getMemoryDbPath } from "./db.js";
import { gitMemoryCommand as git, gitMemoryHeadSnapshot } from "./remote-sync-git.js";

interface PublishedSnapshotConfig {
  file: string;
  recipient?: string;
}

function existingAttributes(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function literalAttributePattern(file: string): string {
  const literal = `/${file.replace(/[\\*?[\]!]/g, "\\$&")}`;
  const quoted = literal.replace(/[\\"\x00-\x1f\x7f]/g, (char) =>
    char === "\\" || char === '"'
      ? `\\${char}`
      : `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
  return `"${quoted}"`;
}

function setCiphertextAttributes(dir: string, file: string): void {
  const info = join(dir, ".git", "info");
  mkdirSync(info, { recursive: true });
  if (!lstatSync(info).isDirectory()) {
    throw new Error("Cannot prepare memory sync through a linked Git info directory");
  }
  const path = join(info, "attributes");
  const content = `${existingAttributes(path)}\n${literalAttributePattern(file)} -filter -text -ident -working-tree-encoding\n`;
  const temporary = mkdtempSync(join(dir, ".git", "kit-memory-attributes-"));
  try {
    const prepared = join(temporary, "attributes");
    writeFileSync(prepared, content, { flag: "wx", mode: 0o600 });
    renameSync(prepared, path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Retain checkout-based hooks while excluding only the ciphertext from Git conversions. */
export function prepareMemoryCheckout(dir: string, file: string): void {
  setCiphertextAttributes(dir, file);
  git(["checkout", "-q", "--force", "--detach", "HEAD"], dir);
}

/** Store ciphertext as an opaque Git blob, without text conversion or clean filters. */
export function stageMemorySnapshot(dir: string, file: string, source: string): string {
  const object = git(["hash-object", "-w", "--no-filters", "--", source], dir).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object)) {
    throw new Error("Git returned an invalid memory snapshot object ID");
  }
  git(["update-index", "--add", "--cacheinfo", "100644", object, file], dir);
  return object;
}

export function matchesPublishedSnapshot(
  cfg: PublishedSnapshotConfig,
  passphrase: string | undefined,
  dir: string,
): boolean {
  const snapshots = gitMemoryHeadSnapshot(dir, cfg.file);
  if (!snapshots) return false;
  const key = cfg.recipient ? loadMemoryKey() : null;
  if (cfg.recipient && (!key || publicKeyString(key.x) !== cfg.recipient)) return false;
  if (!cfg.recipient && !passphrase) return false;
  const previous = join(dir, ".git", "kit-memory-previous.db");
  try {
    for (const blob of snapshots) {
      try {
        if (cfg.recipient) restoreWithKey(key!, blob, previous, "import");
        else restoreEncrypted(passphrase!, blob, previous, "import");
      } catch {
        // A changed key cannot decrypt the previous snapshot. Publish with the configured key.
        return false;
      }
      return memoryDbMatchesSnapshot(getMemoryDbPath(), previous);
    }
    return false;
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
