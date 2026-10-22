/** Remove a temp directory in a test. Retries because Windows keeps a file locked briefly after a child exits (EBUSY). */
import { rmSync } from "node:fs";

export function rmTemp(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
