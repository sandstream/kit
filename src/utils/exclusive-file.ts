/** Publish a complete new file without following an existing dangling symlink.
 *
 * On Windows, `writeFile(..., { flag: "wx" })` can follow a dangling symlink and
 * create its target. A hard link from a same-directory staging file publishes
 * the finished bytes only when the destination name is still unoccupied.
 */
import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function writeFileExclusiveSync(path: string, content: string, mode = 0o666): void {
  const staging = mkdtempSync(join(dirname(path), ".kit-exclusive-"));
  try {
    const temporary = join(staging, "content");
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode });
    linkSync(temporary, path);
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}

export async function writeFileExclusive(
  path: string,
  content: string,
  mode = 0o666,
): Promise<void> {
  const staging = await mkdtemp(join(dirname(path), ".kit-exclusive-"));
  try {
    const temporary = join(staging, "content");
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await link(temporary, path);
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}
