/** Safely publish OneCLI placeholders without following or overwriting linked files. */
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { secureFileStrict } from "../utils/secure-perms.js";

async function envFileState(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameEnvFile(before: Stats, after: Stats | null): boolean {
  return (
    after !== null &&
    after.isFile() &&
    after.nlink === 1 &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readOneCliEnvFile(path: string): Promise<{ content: string; state: Stats | null }> {
  const before = await envFileState(path);
  if (!before) return { content: "", state: null };
  if (!before.isFile() || before.nlink !== 1) {
    throw new Error(".env.local must be a regular file, not a symlink or hard link");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
  );
  try {
    if (!sameEnvFile(before, await handle.stat()))
      throw new Error(".env.local changed before reading");
    const content = await handle.readFile("utf8");
    if (!sameEnvFile(before, await handle.stat()))
      throw new Error(".env.local changed while reading");
    return { content, state: before };
  } finally {
    await handle.close();
  }
}

async function publishOneCliEnvFile(
  path: string,
  content: string,
  previous: Stats | null,
): Promise<void> {
  const staging = await mkdtemp(join(dirname(path), ".kit-onecli-env-"));
  try {
    const temporary = join(staging, "content");
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    secureFileStrict(temporary);
    const current = await envFileState(path);
    if (previous ? !sameEnvFile(previous, current) : current !== null) {
      throw new Error(".env.local changed before publishing the placeholder");
    }
    // A rename replaces the path entry, never the target of a symlink. For a
    // new file, link fails if another process created .env.local first.
    if (previous) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function writeOneCliPlaceholder(keyName: string, placeholder: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) {
    throw new Error("Invalid environment key name");
  }
  const envPath = join(process.cwd(), ".env.local");
  const { content, state } = await readOneCliEnvFile(envPath);
  const newLine = `${keyName}=${placeholder}  # placeholder — real value lives in OneCLI`;
  const lines = content.split("\n");
  const existing = lines.findIndex((line) => line.startsWith(`${keyName}=`));
  if (existing >= 0) {
    lines[existing] = newLine;
    await publishOneCliEnvFile(envPath, lines.join("\n"), state);
    return;
  }
  const prefix = content && !content.endsWith("\n") ? `${content}\n` : content;
  await publishOneCliEnvFile(envPath, `${prefix}${newLine}\n`, state);
}
