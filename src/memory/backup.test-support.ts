import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";
import {
  backupEncrypted,
  restoreEncrypted,
  backupToRecipient,
  restoreWithKey,
  generateMemoryKeypair,
} from "./backup.js";

export const passphrase = "Snapshot-Copper-Orbit-9573";

export const keypair = generateMemoryKeypair();

export const modes = [
  {
    name: "passphrase",
    backup: (src: string, out: string) => backupEncrypted(passphrase, src, out),
    restore: (src: string, out: string) => restoreEncrypted(passphrase, src, out),
  },
  {
    name: "recipient",
    backup: (src: string, out: string) => backupToRecipient(keypair.publicKey, src, out),
    restore: (src: string, out: string) => restoreWithKey(keypair.privateJwk, src, out),
  },
];

export type BackupMode = (typeof modes)[number];

export function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-backup-snapshot-"));
  const handles: DatabaseSync[] = [];
  t.after(() => {
    try {
      for (const db of handles.reverse()) db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return {
    dir,
    src: join(dir, "source.db"),
    blob: join(dir, "backup.enc"),
    dest: join(dir, "restored.db"),
    track(db: DatabaseSync) {
      handles.push(db);
      return db;
    },
  };
}

export function closedSource(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE original (id INTEGER PRIMARY KEY, content TEXT);
      INSERT INTO original VALUES (7, 'preserved');
      CREATE TABLE schema_meta (version INTEGER);
      INSERT INTO schema_meta VALUES (1); PRAGMA user_version = 19`);
  } finally {
    db.close();
  }
}

export const racingBackup = String.raw`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
const [moduleUrl, mode, credential, src, out] = process.argv.slice(1);
const backup = await import(moduleUrl);
const open = fs.openSync;
const close = fs.closeSync;
const read = fs.readSync;
const snapshotDescriptors = new Set();
let raced = false;
fs.openSync = function(path, flags, ...args) {
  const fd = open.call(this, path, flags, ...args);
  if (flags === "r" && typeof path === "string" && path.endsWith("memory.db") && path !== src) {
    snapshotDescriptors.add(fd);
  }
  return fd;
};
fs.closeSync = function(fd) {
  snapshotDescriptors.delete(fd);
  return close.call(this, fd);
};
fs.readSync = function(fd, ...args) {
  const count = read.call(this, fd, ...args);
  if (snapshotDescriptors.has(fd) && count > 0 && !raced) {
    const writer = new DatabaseSync(src);
    try {
      writer.exec("BEGIN IMMEDIATE; UPDATE snapshot_rows SET generation = 1; COMMIT");
      const checkpoint = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint.busy !== 0) throw new Error("writer checkpoint blocked");
    } finally {
      writer.close();
    }
    raced = true;
  }
  return count;
};
syncBuiltinESMExports();
try {
  if (mode === "passphrase") backup.backupEncrypted(credential, src, out);
  else backup.backupToRecipient(credential, src, out);
} finally {
  fs.openSync = open;
  fs.closeSync = close;
  fs.readSync = read;
  syncBuiltinESMExports();
}
process.stdout.write(JSON.stringify({ raced }));
`;

export function restoreMocks(t: TestContext): void {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}
