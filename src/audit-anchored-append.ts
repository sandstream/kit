import { readFile } from "node:fs/promises";
import {
  advanceAuditAnchorUnderLock,
  readAnchorRecord,
  tryReadAuditAnchorKey,
  verifyAgainstAnchor,
  type AnchorRecord,
} from "./audit-anchor.js";
import { AuditAnchorIndexAccessError } from "./audit-anchor-store.js";
import { withAuditWriteLock } from "./audit-write-lock.js";

async function readAppendSnapshot(logPath: string): Promise<string | null> {
  try {
    return await readFile(logPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function verifySealedPrefixForAppend(logPath: string, content: string | null): Promise<void> {
  let record: AnchorRecord | null;
  try {
    record = await readAnchorRecord(logPath);
  } catch (error) {
    // Sandbox permissions can leave only the keyless chain available.
    if (error instanceof AuditAnchorIndexAccessError) return;
    throw error;
  }
  if (!record) return;
  if (content === null) {
    throw new Error("The sealed audit log is missing. Preserve the anchor and inspect the log.");
  }
  const result = verifyAgainstAnchor(content, record, await tryReadAuditAnchorKey());
  if (result.status !== "anchored-ok") {
    throw new Error(
      `Cannot append to the sealed audit log: ${result.reason ?? result.status}. Preserve the log and its anchor.`,
    );
  }
}

/** Hold the log lock across verification, append and optional anchor advance. */
export async function appendWithAuditAnchor(
  logPath: string,
  append: (canonical: string, content: string) => Promise<string>,
): Promise<void> {
  await withAuditWriteLock(logPath, async (canonical) => {
    const content = await readAppendSnapshot(canonical);
    await verifySealedPrefixForAppend(canonical, content);
    const hash = await append(canonical, content ?? "");
    await advanceAuditAnchorUnderLock(canonical, undefined, { expectedTailHashes: [hash] });
  });
}
