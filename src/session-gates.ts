/**
 * `kit hooks gates`: for a repository's committed `SessionStart` hook. Wires the Claude Code
 * PreToolUse gates (`gate-bash`, `gate-env`) into this checkout when it is kit-managed and has none.
 *
 * A committed PreToolUse hook cannot be both portable and live: kit's liveness rule rejects a bare
 * `kit` (a hook shell often lacks PATH), and the forms it accepts name this machine's wrapper or
 * node path. So the repository commits only the `SessionStart` line, and this writes the gates in
 * the resolved form `kit agent-config` uses, on the machine the session runs on. Measured with
 * Claude Code 2.1.326: a PreToolUse hook a `SessionStart` hook writes into
 * `.claude/settings.local.json` blocks the first tool call of that same session.
 *
 * It installs nothing outside a kit-managed checkout (no `.kit.toml`), nothing in read-only mode,
 * and nothing when the gates are already wired. It always exits 0: a `SessionStart` hook cannot
 * block, and what it prints on a zero exit is what the agent reads.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  gateLiveness,
  installEnvWriteGate,
  installInstallGate,
  type HookInstallResult,
} from "./agent-config.js";
import { getCurrentProjectRoot } from "./memory/project.js";
import { isReadOnlyMode } from "./read-only-mode.js";

export type SessionGatesOutcome =
  "installed" | "already-gated" | "not-kit-managed" | "read-only" | "failed";

export interface SessionGatesDeps {
  root: (cwd: string) => string;
  readOnly: () => boolean;
  wired: (root: string) => boolean;
  installBash: (root: string) => Promise<HookInstallResult>;
  installEnv: (root: string) => Promise<HookInstallResult>;
}

function wiredHere(root: string): boolean {
  const live = gateLiveness(root);
  const stale = live.staleMatchers ?? [];
  return (
    live.everInstalled && live.installGate && live.envGate && !live.problems.length && !stale.length
  );
}

const REAL: SessionGatesDeps = {
  root: getCurrentProjectRoot,
  readOnly: isReadOnlyMode,
  wired: wiredHere,
  installBash: installInstallGate,
  installEnv: installEnvWriteGate,
};

/** Wire the gates here when this checkout is kit-managed and ungated. */
export async function ensureSessionGates(
  cwd: string = process.cwd(),
  deps: SessionGatesDeps = REAL,
): Promise<{ outcome: SessionGatesOutcome; line?: string }> {
  const root = deps.root(cwd);
  if (!existsSync(join(root, ".kit.toml"))) return { outcome: "not-kit-managed" };
  if (deps.wired(root)) return { outcome: "already-gated" };
  if (deps.readOnly()) return { outcome: "read-only" };
  try {
    const results = [await deps.installBash(root), await deps.installEnv(root)];
    const failed = results.find((r) => r.action === "failed");
    if (failed) throw new Error(failed.detail ?? `could not update ${failed.file}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      outcome: "failed",
      line: `kit: the PreToolUse gates are not wired in this checkout (${why}). Run: kit agent-config`,
    };
  }
  if (!deps.wired(root)) {
    return {
      outcome: "failed",
      line: "kit: the gate installer ran but gate-bash or gate-env is not wired here. Run: kit agent-config",
    };
  }
  return {
    outcome: "installed",
    line: "kit: wired the PreToolUse gates (gate-bash, gate-env) in this checkout; they apply to this session.",
  };
}

/** The `kit hooks gates` command: one plain line or nothing, always exit 0. */
export async function runHooksGates(): Promise<boolean> {
  try {
    const { line } = await ensureSessionGates();
    if (line) console.log(line);
  } catch {
    // A SessionStart hook never fails the session; `kit check` reports an ungated session.
  }
  return true;
}
