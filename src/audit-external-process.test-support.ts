import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

export function quote(value: string): string {
  return process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

export function fixture(t: TestContext): { root: string; command: (source: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "kit-audit-external-process-"));
  const originalCwd = process.cwd();
  t.after(async () => {
    try {
      // Keep fixture cleanup effective even when an assertion fails before cleanup checks.
      for (const name of readdirSync(root).filter((name) => name.endsWith(".pid"))) {
        const pid = Number(readFileSync(join(root, name), "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0 && pidExists(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
          await assertStopped(pid);
        }
      }
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
  let index = 0;
  return {
    root,
    command(source) {
      const script = join(root, `command-${index++}.cjs`);
      writeFileSync(script, source);
      return `${quote(process.execPath)} ${quote(script)}`;
    },
  };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function assertStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (pidExists(pid) && Date.now() < deadline) await delay(10);
  assert.equal(pidExists(pid), false, `test process ${pid} must be gone`);
}

export function trackedPid(path: string): () => number {
  return () => Number(readFileSync(path, "utf8"));
}
