/**
 * Gates in a new worktree.
 *
 * The PreToolUse gates are installed per checkout: the marker and `settings.local.json` live in the
 * ignored `.claude/`, so a linked worktree starts without them and an agent working there runs
 * ungated on the very machine where the gates were installed. `kit check` reports that
 * (`enforcement gate liveness`), but reporting it is not enough: the session that needs the gates
 * has already started by then. (A hook written during a session does apply to it: measured with
 * Claude Code 2.1.326, see src/session-gates.ts. A session in a worktree still starts ungated
 * unless something writes the gates first.)
 *
 * This installs them when the worktree is created (the `post-checkout` hook calls it), and only
 * mirrors a main checkout that already has them: it never imposes gates on a project that chose none.
 *
 * The deny floor is mirrored the same way. `kit agent-config` also writes kit's Claude Code deny rules
 * and the sandbox block into `.claude/settings.json` (src/agent-config-strict.ts). That file sits in
 * the same ignored `.claude/` in most projects, so a new worktree got the hooks but none of the deny
 * rules: `Read(~/.ssh/**)`, `.env*` and force push were refused in the main checkout and allowed in
 * the worktree (kit-research#241, T3 Code, which starts agents in worktrees). When the main
 * checkout carries the floor (the marker `kit agent-config` writes, or any kit deny rule in its
 * settings), the worktree gets the same merge, and is reported failed until every rule is there.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { gateLiveness, gateMarkerPath, installAllInstallGates } from "./agent-config.js";
import { denyRulesMarkerPath, installStrictSettings } from "./agent-config-strict.js";
import { heldKitDenyRules, missingKitDenyRules, permissionListsOf } from "./kit-deny-rules.js";
import { getCanonicalProjectRoot } from "./memory/canonical-root.js";
import { getCurrentProjectRoot } from "./memory/project.js";
import { isReadOnlyMode } from "./read-only-mode.js";

export type WorktreeGatesOutcome =
  "installed" | "already-gated" | "not-a-worktree" | "main-not-gated" | "failed";

export interface WorktreeGatesResult {
  outcome: WorktreeGatesOutcome;
  detail: string;
}

type Installer = (cwd: string) => Promise<void>;

async function installDefault(cwd: string): Promise<void> {
  await installAllInstallGates(cwd, { worktreeHook: false });
}

/** The deny rules and sandbox block of `kit agent-config`, merged as it merges them. */
async function installFloorDefault(cwd: string): Promise<void> {
  const r = await installStrictSettings(cwd);
  if (r.action === "failed" || r.action === "skipped") {
    throw new Error(`the deny rules were not written: ${r.detail ?? r.action}`);
  }
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

/** The kit deny rules in a checkout's `.claude/settings.json`; null when it is absent or unreadable. */
function denyList(cwd: string): string[] | null {
  try {
    return (
      permissionListsOf(readFileSync(resolve(cwd, ".claude", "settings.json"), "utf-8"))?.deny ??
      null
    );
  } catch {
    return null;
  }
}

/** The same test as the `deny rule liveness` row: the marker, or any kit deny rule in the settings. */
function hasFloor(cwd: string): boolean {
  return existsSync(denyRulesMarkerPath(cwd)) || heldKitDenyRules(denyList(cwd) ?? []).length > 0;
}

/** Every kit deny rule is in the checkout's `.claude/settings.json`. */
function floorLive(cwd: string): boolean {
  const deny = denyList(cwd);
  return deny !== null && missingKitDenyRules(deny).length === 0;
}

interface Wanted {
  gates: boolean;
  floor: boolean;
}

/** What the worktree still lacks, of what the main checkout has. */
function lacking(here: string, want: Wanted): Wanted {
  return { gates: want.gates && !wired(here), floor: want.floor && !floorLive(here) };
}

function notWiredDetail(left: Wanted): string {
  const parts = [
    ...(left.gates ? ["the install gate or the env-write gate is not wired here"] : []),
    ...(left.floor ? ["kit's deny rules are not all in .claude/settings.json here"] : []),
  ];
  return `the installer ran but ${parts.join(", and ")}`;
}

async function installLacking(
  here: string,
  need: Wanted,
  install: Installer,
  installFloor: Installer,
): Promise<string | null> {
  try {
    // The Claude Code installers skip a checkout with neither `.claude/` nor `CLAUDE.md`. The main
    // checkout has `.claude/` (the marker above lives there), but both are often untracked, so a new
    // worktree had neither and was left ungated while git printed "not wired here" — in a tool that
    // creates a worktree per agent, nobody reads that line. Mirror the directory the gates belong in.
    if (!isReadOnlyMode()) mkdirSync(resolve(here, ".claude"), { recursive: true });
    if (need.gates) await install(here);
    if (need.floor) await installFloor(here);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Install the gates, and the deny floor, in `cwd` when it is a linked worktree of a main checkout
 * that has them and it does not.
 */
export async function ensureWorktreeGates(
  cwd: string = process.cwd(),
  install: Installer = installDefault,
  installFloor: Installer = installFloorDefault,
): Promise<WorktreeGatesResult> {
  const here = getCurrentProjectRoot(cwd);
  const main = getCanonicalProjectRoot(cwd);
  if (sameDir(here, main)) {
    return { outcome: "not-a-worktree", detail: "this is the main checkout" };
  }
  const want = { gates: existsSync(gateMarkerPath(main)), floor: hasFloor(main) };
  if (!want.gates && !want.floor) {
    return {
      outcome: "main-not-gated",
      detail: `the main checkout ${main} has no gates to mirror`,
    };
  }
  const need = lacking(here, want);
  if (!need.gates && !need.floor) {
    return { outcome: "already-gated", detail: "the gates are already wired here" };
  }
  const why = await installLacking(here, need, install, installFloor);
  if (why !== null) {
    return { outcome: "failed", detail: `the gates could not be installed: ${why}` };
  }
  const left = lacking(here, want);
  if (left.gates || left.floor) return { outcome: "failed", detail: notWiredDetail(left) };
  return { outcome: "installed", detail: `the gates of ${main} are now wired here` };
}
