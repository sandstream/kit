import { readFile, writeFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AnchorRecord } from "./audit-anchor.js";
import { canonicalAuditLogPath } from "./audit-log-path.js";
import { secureFileStrict } from "./utils/secure-perms.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";
import { externalReceiptIdentity, validExternalStatement } from "./audit-external.js";

export type AnchorStore = Record<string, AnchorRecord>;

export async function readAnchorStore(path: string): Promise<AnchorStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected an anchor index object.");
    }
    if (!Object.values(parsed).every(isAnchorRecord)) {
      throw new Error("Invalid anchor record.");
    }
    return parsed as AnchorStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // eslint-disable-next-line preserve-caught-error -- Parser errors can disclose index content.
    throw new Error(
      "The audit anchor index is unreadable or invalid. Preserve it before recovery.",
    );
  }
}

function isAnchorRecord(value: unknown): value is AnchorRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tip === "string" &&
    /^[a-f0-9]{64}$/i.test(record.tip) &&
    Number.isSafeInteger(record.count) &&
    (record.count as number) >= 0 &&
    record.algo === "hmac-sha256" &&
    typeof record.updatedAt === "string" &&
    validExternalReceipt(record.external)
  );
}

function validExternalReceipt(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    ["token", "authority", "timestamp"].every(
      (field) => typeof receipt[field] === "string" && receipt[field].trim().length > 0,
    ) &&
    (receipt.statement === undefined || validExternalStatement(receipt.statement))
  );
}

function sameLog(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    const first = canonicalAuditLogPath(left),
      second = canonicalAuditLogPath(right);
    return first === second || sameIdentity(identityOf(first), identityOf(second));
  } catch {
    return false;
  }
}

export function findAnchorRecord(store: AnchorStore, logPath: string): AnchorRecord | null {
  const matches = Object.entries(store).filter(([path]) => sameLog(path, logPath));
  const first = matches[0]?.[1];
  if (!first) return null;
  for (const [, record] of matches.slice(1)) {
    assertSameAnchor(first, record);
  }
  return first;
}

function assertSameAnchor(first: AnchorRecord, record: AnchorRecord): void {
  if (
    record.tip !== first.tip ||
    record.count !== first.count ||
    record.version !== first.version ||
    record.keyFingerprint !== first.keyFingerprint ||
    externalReceiptIdentity(record.external) !== externalReceiptIdentity(first.external)
  ) {
    throw new Error(
      "Conflicting audit anchors refer to the same log. Preserve the index and inspect both records.",
    );
  }
}

function aliasKeys(logPath: string): string[] {
  let canonical: string;
  try {
    canonical = canonicalAuditLogPath(logPath);
  } catch {
    return [`path:${logPath}`];
  }
  const keys = [`path:${canonical}`];
  try {
    const identity = identityOf(canonical);
    if (identity && identity.ino !== 0n) keys.push(`file:${identity.dev}:${identity.ino}`);
  } catch {
    // The canonical path still identifies aliases when file metadata is unavailable.
  }
  return keys;
}

/** Validate aliases once per path while retaining every stored path in the union. */
export function listAnchorRecords(
  store: AnchorStore,
): Array<{ logPath: string; record: AnchorRecord }> {
  const seen = new Map<string, AnchorRecord>();
  return Object.keys(store)
    .sort()
    .map((logPath) => {
      const record = store[logPath];
      for (const key of aliasKeys(logPath)) {
        const previous = seen.get(key);
        if (previous) assertSameAnchor(previous, record);
        seen.set(key, record);
      }
      return { logPath, record };
    });
}

async function publishStore(path: string, store: AnchorStore): Promise<void> {
  const temporary = join(dirname(path), `.kit-audit-index-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    secureFileStrict(temporary);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Merge and atomically publish one seal while other logs retain their records. */
export async function storeAnchorRecord(
  path: string,
  logPath: string,
  record: AnchorRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const canonical = canonicalAuditLogPath(path);
  const { withSqliteMutex } = await import("./sqlite-mutex.js");
  await withSqliteMutex(`${canonical}.lock.sqlite`, async () => {
    const store = await readAnchorStore(canonical);
    for (const storedPath of Object.keys(store)) {
      if (sameLog(storedPath, logPath)) {
        delete store[storedPath];
        continue;
      }
      try {
        await stat(storedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") delete store[storedPath];
      }
    }
    store[canonicalAuditLogPath(logPath)] = record;
    await publishStore(canonical, store);
  });
}
