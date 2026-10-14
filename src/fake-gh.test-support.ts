import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Put a recording stand-in for `gh` first on PATH so a test that exercises the GitHub target of
 * `propagate` can never reach the real CLI. On a developer machine `gh` is authenticated, and an
 * unguarded call writes a real Actions secret to whatever repo the test runs in.
 *
 * The stand-in logs its argv, drains stdin and exits 1, so adapters still see a failed push.
 * On Windows a spawned `gh` must be an executable, not a script, so node.exe stands in under
 * that name: it rejects `secret set` with a non-zero exit and records nothing (calls() is empty).
 */
export function installFakeGh(): { calls: () => string[]; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kit-fake-gh-"));
  const log = join(dir, "calls.log");
  if (process.platform === "win32") {
    copyFileSync(process.execPath, join(dir, "gh.exe"));
  } else {
    const bin = join(dir, "gh");
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\ncat >/dev/null\nexit 1\n`);
    chmodSync(bin, 0o755);
  }
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${priorPath ?? ""}`;
  return {
    calls: () => {
      try {
        return readFileSync(log, "utf-8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    restore: () => {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run `fn` with the stand-in `gh` installed, then restore PATH even when `fn` throws. */
export async function withFakeGh<T>(fn: () => Promise<T>): Promise<T> {
  const gh = installFakeGh();
  try {
    return await fn();
  } finally {
    gh.restore();
  }
}
