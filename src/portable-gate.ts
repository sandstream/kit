/**
 * A gate entry that can be committed.
 *
 * kit's gate command is `"$HOME/.kit/bin/kit" gate-bash`: a wrapper kit writes on the machine where
 * `kit agent-config` ran. On another clone the wrapper is missing and the hook cannot start, so kit
 * keeps the gates out of a tracked `.claude/settings.json` and writes them to
 * `settings.local.json`. A fresh checkout on an agent host then has no gates at all
 * (kit-research `opencomputer-vs-kit`).
 *
 * The portable entry is one POSIX `sh` line that works wherever kit is installed:
 *   - it runs the wrapper when the machine has one, and `kit` from `PATH` otherwise;
 *   - when neither exists it prints why and exits 2, which the harness treats as a refusal. A
 *     checkout whose gates cannot run does not run ungated.
 *
 * kit recognises the entry by exact text: only the line kit generates counts as a kit gate, so an
 * edited copy is not trusted. `kit agent-config --portable-gates` writes it to the shared settings
 * file; after that the repository stays in this mode, because the mode is read from the file.
 *
 * Not verified: native Windows and macOS. The line needs `sh`; no CI job runs it under a Windows
 * hook shell or on a Mac.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { hasFlag } from "./utils/flags.js";

const GATES = ["gate-bash", "gate-env", "gate-egress", "gate-fs", "gate-limits"];
const SHARED_SETTINGS = join(".claude", "settings.json");

/** The committed gate line for one gate subcommand. */
export function portableGateCommand(sub: string): string {
  const missing =
    "kit is not installed here and this repository requires its gates: npm i -g sandstream-kit";
  return `sh -c 'k="$HOME/.kit/bin/kit"; [ -x "$k" ] || k=kit; command -v "$k" >/dev/null 2>&1 || { echo "${missing}" >&2; exit 2; }; exec "$k" ${sub}'`;
}

/** The gate subcommand a command is the portable line for, or null. Exact text only. */
export function portableGateSubcommand(command: string): string | null {
  const text = command.trim();
  return GATES.find((sub) => text === portableGateCommand(sub)) ?? null;
}

function executable(path: string): boolean {
  try {
    const s = statSync(path);
    return s.isFile() && (process.platform === "win32" || (s.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function onPath(env: NodeJS.ProcessEnv): string | null {
  const names = process.platform === "win32" ? ["kit.cmd", "kit.exe", "kit"] : ["kit"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    const hit = names.map((n) => join(dir, n)).find(executable);
    if (hit) return hit;
  }
  return null;
}

/**
 * What a hook command starts on this machine. A portable line becomes the direct command it
 * would exec (`"<wrapper or kit on PATH>" <sub>`), so the liveness and identity checks read it as
 * they read any gate. When kit is in neither place the result is `kit <sub>`, which those checks
 * report as not runnable. Any other command is returned unchanged.
 */
export function effectiveHookCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const sub = portableGateSubcommand(command);
  if (!sub) return command;
  const wrapper = join(home, ".kit", "bin", "kit");
  const target = executable(wrapper) ? wrapper : onPath(env);
  return target ? `"${target}" ${sub}` : `kit ${sub}`;
}

/** Whether the shared settings file of `cwd` already holds a portable gate line. */
export function holdsPortableGate(cwd: string): boolean {
  const path = join(cwd, SHARED_SETTINGS);
  if (!existsSync(path)) return false;
  try {
    const hooks = (JSON.parse(readFileSync(path, "utf-8")) as { hooks?: { PreToolUse?: unknown } })
      .hooks?.PreToolUse;
    return (Array.isArray(hooks) ? hooks : []).some((group) =>
      ((group as { hooks?: { command?: unknown }[] })?.hooks ?? []).some(
        (h) => typeof h?.command === "string" && portableGateSubcommand(h.command) !== null,
      ),
    );
  } catch {
    return false;
  }
}

/** Whether gates for `cwd` are written as portable lines: asked for now, or already so. */
export function portableGatesMode(cwd: string, argv: string[] = process.argv): boolean {
  return hasFlag(argv, "--portable-gates") || holdsPortableGate(cwd);
}
