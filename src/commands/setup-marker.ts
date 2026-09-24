/** Record the first-install prompt without following an existing marker symlink. */
import { writeFile } from "node:fs/promises";

export async function recordFirstInstallPrompt(path: string): Promise<void> {
  try {
    await writeFile(path, new Date().toISOString() + "\n", {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
