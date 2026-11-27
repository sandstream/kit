/** The kit command line that agents' hook files run, resolved once per machine. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { kitWrapperPath } from "./kit-wrapper.js";

/**
 * The gate command for a non-login hook shell. Mirrors the memory-hook invocation
 * (`kitHookInvocation`): prefer the self-healing wrapper at the STABLE path
 * `~/.kit/bin/kit`. Repo-shared command strings use `$HOME` rather than baking the
 * current machine's home directory; the wrapper itself remains machine-local and
 * may safely contain absolute node/kit paths.
 *
 * Two concrete wins over baking `<node> <cli.js>` straight into every agent's config:
 *   1. It restores the tool PATH a non-login hook shell drops (npm-global bin, mise
 *      shims). The gate shells out to `python3` (triage) and `git`; without that
 *      PATH those fail — triage then fail-closes and BLOCKS legitimate installs
 *      (false-block spam), the opposite of what we want operators to live with.
 *   2. There is ONE stable path to refresh. If node moves (nvm/volta/fnm) or kit
 *      relocates, `ensureKitWrapper` rewrites the single wrapper in place and every
 *      agent's hook — which all point at `~/.kit/bin/kit` — is fixed at once; no
 *      per-agent re-wiring, and no stale absolute node path frozen into a config
 *      file that would make the PreToolUse hook fail to spawn (a silent false green).
 * Fall back to an absolute `<node> <cli.js>`, then a bare `kit` (relies on PATH —
 * the last resort, kept only so the string is never empty).
 */
export function kitGateInvocation(): string {
  return kitSubcommandInvocation("gate-bash");
}

/** Same stable-wrapper resolution for any kit subcommand baked into a hook. */
export function kitSubcommandInvocation(sub: string): string {
  // The POSIX wrapper cannot run in a native Windows hook shell. Use the
  // executable entrypoint directly until the Windows shim can be refreshed.
  if (process.platform === "win32") {
    const entry = process.argv[1];
    if (entry) return `"${process.execPath}" "${resolve(entry)}" ${sub}`;
    return `kit.cmd ${sub}`;
  }
  const wrapper = kitWrapperPath();
  if (existsSync(wrapper)) return `"$HOME/.kit/bin/kit" ${sub}`;
  const entry = process.argv[1];
  if (entry) return `${process.execPath} ${resolve(entry)} ${sub}`;
  return `kit ${sub}`; // last resort — relies on PATH
}
