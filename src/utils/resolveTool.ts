import { execFileNoThrow } from "./execFileNoThrow.js";

/**
 * Resolve a tool's executable to an absolute path — mise-first, then PATH.
 *
 * kit installs tools via mise, but mise shims are only on a shell's PATH when
 * mise is *activated* there. kit's own process (and the hooks it writes) run
 * without that activation, so a bare `execFileNoThrow("semgrep")` can't find a
 * mise-installed scanner even though it's installed. `mise which <tool>` returns
 * the real binary path regardless of shim activation; we fall back to the
 * system PATH (`which`) for tools installed outside mise. Returns null if the
 * tool can't be found either way.
 *
 * Args are always passed as an array (no shell string) per the exec security
 * invariant, so a tool name can't inject.
 */
export async function resolveToolBin(tool: string): Promise<string | null> {
  const viaMise = await execFileNoThrow("mise", ["which", tool], { timeout: 8_000 });
  if (viaMise.ok) {
    const p = viaMise.stdout.trim().split("\n")[0]?.trim();
    if (p) return p;
  }
  // POSIX `which`, Windows `where` (no POSIX shell on native Windows) — #43.
  const finder = process.platform === "win32" ? "where" : "which";
  const viaPath = await execFileNoThrow(finder, [tool], { timeout: 5_000 });
  if (viaPath.ok) {
    const p = viaPath.stdout.trim().split("\n")[0]?.trim();
    if (p) return p;
  }
  return null;
}
