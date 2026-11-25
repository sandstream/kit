import { rmSync } from "node:fs";

const retryDelay = 100;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Remove a test directory even if Windows briefly holds it open after a child exits. */
export function rmTemp(path: string): void {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay });
      return;
    } catch (error) {
      // Node 22 can report EBUSY on its first rmdir, before its internal retry loop.
      if (
        process.platform !== "win32" ||
        (error as NodeJS.ErrnoException).code !== "EBUSY" ||
        performance.now() >= deadline
      )
        throw error;
      Atomics.wait(sleepCell, 0, 0, retryDelay);
    }
  }
}
