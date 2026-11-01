/** Read an authority-bearing audit key only from a private, stable file. */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateFileIsControlled } from "./utils/secure-perms.js";

function unsafeKey(path: string): Error {
  return new Error(
    `Audit anchor key at ${path} is not a private regular file owned by the current user. Preserve the existing key and restrict its permissions before retrying.`,
  );
}

class LinkedAnchorKeyError extends Error {}

async function linkedKeyError(path: string, info: BigIntStats): Promise<Error> {
  const directory = dirname(path);
  try {
    const names = await readdir(directory);
    for (const name of names.filter((item) =>
      /^\.kit-audit-anchor-[a-f0-9]{32}\.tmp$/.test(item),
    )) {
      const temp = join(directory, name);
      const entry = await lstat(temp, { bigint: true });
      if (
        entry.isFile() &&
        entry.nlink === 2n &&
        entry.dev === info.dev &&
        entry.ino === info.ino
      ) {
        return new LinkedAnchorKeyError(
          `Audit anchor key ${path} and temporary file ${temp} are links to the same file. Preserve both and stop all key users. Matching identities do not prove ownership. A qualified person must inspect them and confirm the temporary name belongs to the interrupted creation before any manual removal.`,
        );
      }
    }
  } catch {
    // Preserve the generic refusal if the directory cannot be inspected.
  }
  return new LinkedAnchorKeyError(
    `Audit anchor key at ${path} has multiple links. Preserve every name and have a qualified person inspect the key directory before any manual action.`,
  );
}

async function checkedIdentity(handle: FileHandle, path: string): Promise<BigIntStats> {
  const info = await handle.stat({ bigint: true });
  const entry = await lstat(path, { bigint: true });
  if (
    !info.isFile() ||
    !entry.isFile() ||
    info.ino === 0n ||
    info.dev !== entry.dev ||
    info.ino !== entry.ino
  )
    throw unsafeKey(path);
  if (info.nlink !== 1n) throw await linkedKeyError(path, info);
  return info;
}

function assertPrivateKey(info: BigIntStats, path: string): void {
  const uid = process.getuid?.();
  if (
    process.platform === "win32"
      ? !privateFileIsControlled(path)
      : (info.mode & 0o077n) !== 0n || (uid !== undefined && info.uid !== BigInt(uid))
  )
    throw unsafeKey(path);
}

async function readProtectedAnchorKeyOnce(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Cannot safely open audit anchor key at ${path}. Preserve and inspect the existing key.`,
      { cause: error },
    );
  }
  try {
    const info = await checkedIdentity(handle, path);
    if (info.size === 0n) return null;
    assertPrivateKey(info, path);
    if (info.size > 4096n)
      throw new Error(
        `Audit anchor key at ${path} is too large. Preserve and inspect the existing key.`,
      );
    const hex = (await handle.readFile("utf8")).trim();
    const final = await checkedIdentity(handle, path);
    assertPrivateKey(final, path);
    if (final.size !== info.size) throw unsafeKey(path);
    if (hex.length < 64) return null;
    if (!/^(?:[a-f0-9]{2}){32,}$/i.test(hex))
      throw new Error(
        `Audit anchor key at ${path} is invalid. Preserve and inspect the existing key.`,
      );
    return Buffer.from(hex, "hex");
  } finally {
    await handle.close();
  }
}

export async function readProtectedAnchorKey(path: string): Promise<Buffer | null> {
  for (let index = 0; index < 5; index++) {
    try {
      return await readProtectedAnchorKeyOnce(path);
    } catch (error) {
      if (!(error instanceof LinkedAnchorKeyError) || index === 4) throw error;
      await new Promise((done) => setTimeout(done, 50 * (index + 1)));
    }
  }
  throw new Error(`Cannot read audit anchor key at ${path}.`);
}

export async function waitForProtectedAnchorKey(path: string): Promise<Buffer> {
  const attempts = process.platform === "win32" ? 40 : 5;
  for (let index = 0; index < attempts; index++) {
    const key = await readProtectedAnchorKey(path);
    if (key) return key;
    if (index < attempts - 1) await new Promise((done) => setTimeout(done, 15 * (index + 1)));
  }
  throw new Error(
    `Audit anchor key at ${path} did not become complete. Preserve and inspect the existing key.`,
  );
}
