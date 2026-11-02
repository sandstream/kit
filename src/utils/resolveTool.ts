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
export interface ResolveDeps {
  exec: typeof execFileNoThrow;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

const DEFAULT_DEPS: ResolveDeps = {
  exec: execFileNoThrow,
  env: process.env,
  platform: process.platform,
};

const MISE_SHIMS_ON_PATH = /mise[\\/]shims/;

/**
 * mise's installed binary can fail where its shim works. A pipx-installed `semgrep` re-runs itself
 * as `osemgrep`, which only the shims directory can serve, so with shims first on PATH (kit's own
 * wrapper does that) the installed binary dies with "osemgrep is not a valid shim". Only that
 * message counts: a tool that merely rejects `--version` still starts.
 */
async function startsUnderShims(bin: string, deps: ResolveDeps): Promise<boolean> {
  if (!MISE_SHIMS_ON_PATH.test(deps.env.PATH ?? deps.env.Path ?? "")) return true;
  const probe = await deps.exec(bin, ["--version"], { timeout: 15_000, env: deps.env });
  return !/is not a valid shim/i.test(probe.stderr);
}

async function firstLine(deps: ResolveDeps, cmd: string, args: string[]) {
  const r = await deps.exec(cmd, args, { timeout: cmd === "mise" ? 8_000 : 5_000 });
  return r.ok ? r.stdout.trim().split("\n")[0]?.trim() || null : null;
}

export async function resolveToolBin(
  tool: string,
  deps: ResolveDeps = DEFAULT_DEPS,
): Promise<string | null> {
  const viaMise = await firstLine(deps, "mise", ["which", tool]);
  // POSIX `which`, Windows `where` (no POSIX shell on native Windows) — #43.
  const finder = deps.platform === "win32" ? "where" : "which";
  const viaPath = () => firstLine(deps, finder, [tool]);
  if (viaMise && (await startsUnderShims(viaMise, deps))) return viaMise;
  return (await viaPath()) ?? viaMise;
}
