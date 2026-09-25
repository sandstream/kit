/** Record the first-install prompt without following an existing marker symlink. */
import { writeFileExclusive } from "../utils/exclusive-file.js";

export async function recordFirstInstallPrompt(path: string): Promise<void> {
  try {
    await writeFileExclusive(path, new Date().toISOString() + "\n", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
