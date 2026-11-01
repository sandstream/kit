/** Create or read an audit anchor key at an explicit path. */
import { readFile, writeFile, mkdir, open, lstat, type FileHandle } from "node:fs/promises";
import { fstatSync, linkSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { secureFile, secureFileStrict } from "./utils/secure-perms.js";
import { reReadHexKey } from "./utils/key-file.js";
import { readProtectedAnchorKey, waitForProtectedAnchorKey } from "./audit-anchor-protected.js";

async function assertAnchorFileIdentity(handle: FileHandle, path: string): Promise<void> {
  const actual = await handle.stat({ bigint: true });
  const entry = await lstat(path, { bigint: true });
  if (
    !actual.isFile() ||
    !entry.isFile() ||
    actual.ino === 0n ||
    actual.nlink !== 1n ||
    actual.dev !== entry.dev ||
    actual.ino !== entry.ino
  ) {
    throw new Error(`new audit anchor key file changed at ${path}`);
  }
}

function assertLinkedAnchor(handle: FileHandle, path: string, links: bigint): void {
  const actual = fstatSync(handle.fd, { bigint: true });
  const entry = lstatSync(path, { bigint: true });
  if (
    !actual.isFile() ||
    !entry.isFile() ||
    actual.ino === 0n ||
    actual.nlink !== links ||
    actual.dev !== entry.dev ||
    actual.ino !== entry.ino
  ) {
    throw new Error(`audit anchor key file changed at ${path}`);
  }
}

async function createGuardedAnchorKey(
  path: string,
  key: Buffer,
  beforeCreate: () => void,
): Promise<Buffer> {
  const temp = join(dirname(path), `.kit-audit-anchor-${randomBytes(16).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await assertAnchorFileIdentity(handle, temp);
    beforeCreate();
    secureFileStrict(temp);
    await assertAnchorFileIdentity(handle, temp);
    beforeCreate();
    await handle.writeFile(key.toString("hex") + "\n", "utf8");
    await assertAnchorFileIdentity(handle, temp);
    const retained = await readProtectedAnchorKey(temp);
    if (!retained || !retained.equals(key)) throw new Error(`audit anchor key changed at ${temp}`);
    beforeCreate();
    try {
      linkSync(temp, path);
    } catch (error) {
      assertLinkedAnchor(handle, temp, 1n);
      unlinkSync(temp);
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return waitForProtectedAnchorKey(path);
      throw error;
    }
    beforeCreate();
    assertLinkedAnchor(handle, temp, 2n);
    assertLinkedAnchor(handle, path, 2n);
    unlinkSync(temp);
    assertLinkedAnchor(handle, path, 1n);
    return key;
  } catch (error) {
    if (error instanceof Error)
      error.message += ` Preserve and inspect any key artifacts at ${temp} and ${path}.`;
    throw error;
  } finally {
    await handle.close();
  }
}

/** Read or create the machine key. A supplied guard enables protected creation and reads. */
export async function getAuditAnchorKeyAt(
  keyPath: string,
  rootDir: string,
  beforeCreate?: () => void,
): Promise<Buffer> {
  if (beforeCreate) {
    const protectedKey = await readProtectedAnchorKey(keyPath);
    if (protectedKey) return protectedKey;
  } else {
    try {
      const hex = (await readFile(keyPath, "utf-8")).trim();
      if (hex.length >= 64) return Buffer.from(hex, "hex");
    } catch {
      /* fall through to create */
    }
  }
  const key = randomBytes(32);
  beforeCreate?.();
  await mkdir(rootDir, { recursive: true });
  beforeCreate?.();
  if (beforeCreate) return createGuardedAnchorKey(keyPath, key, beforeCreate);
  try {
    await writeFile(keyPath, key.toString("hex") + "\n", {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    // Lost the create race. Re-read the winner's key WITH the same length guard
    // as the happy path (+ retry) so a mid-write read can never hand back a
    // short/empty key (which would later look like a tip-mismatch). #fix5
    return reReadHexKey(keyPath, 64, process.platform === "win32" ? 40 : 5);
  }
  try {
    secureFile(keyPath); // owner-only on Windows (NTFS ignores mode)
  } catch {
    return reReadHexKey(keyPath);
  }
  return key;
}
