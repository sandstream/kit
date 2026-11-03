/**
 * Gates in a new worktree.
 *
 * The PreToolUse gates are installed per checkout: the marker and `settings.local.json` live in the
 * ignored `.claude/`, so a linked worktree starts without them and an agent working there runs
 * ungated on the very machine where the gates were installed. `kit check` reports that
 * (`enforcement gate liveness`), but reporting it is not enough: the session that needs the gates
 * has already started by then, and a hook added during a session is not active in it.
 *
 * This installs them when the worktree is created (the `post-checkout` hook calls it), and only
 * mirrors a main checkout that already has them: it never imposes gates on a project that chose none.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { gateLiveness, gateMarkerPath, installAllInstallGates } from "./agent-config.js";
import { getCanonicalProjectRoot } from "./memory/canonical-root.js";
import { getCurrentProjectRoot } from "./memory/project.js";

export type WorktreeGatesOutcome =
  "installed" | "already-gated" | "not-a-worktree" | "main-not-gated" | "failed";

export interface WorktreeGatesResult {
  outcome: WorktreeGatesOutcome;
  detail: string;
}

async function installDefault(cwd: string): Promise<void> {
  await installAllInstallGates(cwd);
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function wired(cwd: string): boolean {
  const live = gateLiveness(cwd);
  return live.everInstalled && live.installGate && live.envGate && live.problems.length === 0;
}

/** Install the gates in `cwd` when it is a linked worktree of a gated main checkout and has none. */
export async function ensureWorktreeGates(
  cwd: string = process.cwd(),
  install: (cwd: string) => Promise<void> = installDefault,
): Promise<WorktreeGatesResult> {
  const here = getCurrentProjectRoot(cwd);
  const main = getCanonicalProjectRoot(cwd);
  if (sameDir(here, main)) {
    return { outcome: "not-a-worktree", detail: "this is the main checkout" };
  }
  if (!existsSync(gateMarkerPath(main))) {
    return {
      outcome: "main-not-gated",
      detail: `the main checkout ${main} has no gates to mirror`,
    };
  }
  if (wired(here)) return { outcome: "already-gated", detail: "the gates are already wired here" };
  try {
    await install(here);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", detail: `the gates could not be installed: ${why}` };
  }
  if (!wired(here)) {
    return {
      outcome: "failed",
      detail: "the installer ran but the install gate or the env-write gate is not wired here",
    };
  }
  return { outcome: "installed", detail: `the gates of ${main} are now wired here` };
}
