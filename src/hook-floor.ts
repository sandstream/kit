/**
 * Where kit's git-hook enforcement floor actually is, and whether it can fail.
 *
 * README calls git hooks "the agent-agnostic enforcement floor" — the one that fires in any
 * agent or none. Two properties of that floor were unreported, and both were measured (#496,
 * #497):
 *
 * 1. **Location.** `resolveHooksDir()` honors `core.hooksPath`, which is right: installing into
 *    `.git/hooks` while git reads elsewhere is a silent no-op. But only the WRITER used it. Two
 *    readers — `check-hooks.ts:checkHooks` and `commands/hooks.ts`'s own already-installed
 *    pre-check — hardcoded `<gitDir>/hooks`, so with an external `core.hooksPath` kit installed
 *    to one directory and reported on another. That disagreement is the root defect; this module
 *    plus those two call-site fixes close it.
 *
 *    Measured consequence: a second checkout made by copying the first inherits the first's
 *    ABSOLUTE `core.hooksPath`, so its hooks live in the other clone's tree. Deleting that
 *    unrelated directory removed the gate — the same staged fake credential that was blocked
 *    before committed cleanly afterwards, exit 0, with every kit report still silent.
 *
 * 2. **Armed or not.** `kit hooks add context-check` installed a pre-push hook that, with no
 *    `[context]` block to compare against, passed unconditionally. `✓ installed` for a gate that
 *    cannot fail is the false green kit exists to refuse.
 *
 * The rule this module applies is kit's own: coverage that could not run is UNKNOWN, never
 * clean. A floor that is external is fragile, a floor whose directory is gone is off, and an
 * installed gate with nothing to check is not a gate.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { resolveHooksDir } from "./hooks.js";
import { pathInWorkingTree } from "./kit-wrapper.js";
import { homedir } from "node:os";
import type { kitConfig } from "./config.js";

/** The kit-managed built-in hooks, keyed by the git hook file they install into. */
export const BUILTIN_HOOK_FILES: Record<string, { name: string; command: string }> = {
  "pre-commit": { name: "secret-scan", command: "security scan-staged" },
  "post-merge": { name: "post-pull-audit", command: "security verify-pull" },
  "pre-push": { name: "context-check", command: "context check" },
};

export interface HookFloorReport {
  /** The directory git will actually run hooks from. */
  dir: string;
  /** `core.hooksPath` when set — the reason `dir` may not be `<repo>/.git/hooks`. */
  hooksPath?: string;
  /** True when `dir` is not inside the repo root: the floor lives outside the repo. */
  external: boolean;
  /** False when `dir` does not exist. Every hook is then off, whatever is declared. */
  exists: boolean;
  /** Built-in hooks found installed in `dir` (by kit-managed marker), e.g. ["secret-scan"]. */
  installed: string[];
  /**
   * Installed hooks that cannot fail as configured. Today: `context-check` with no `[context]`
   * block — nothing to compare the live CLI state against, so the push gate always passes.
   */
  unarmed: string[];
}

/** Is `child` inside `parent`? Realpath-free: callers pass already-resolved paths. */
function isInside(parent: string, child: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(p);
}

/**
 * Describe the floor for one repo. Pure w.r.t. its inputs (`cwd`, config) apart from reading
 * the filesystem and git config, so every branch is reachable in a test with a temp repo.
 */
export function describeHookFloor(cwd = process.cwd(), config?: kitConfig): HookFloorReport {
  const repoRoot = resolve(cwd);
  const dir = resolve(resolveHooksDir(".git", repoRoot));
  let hooksPath: string | undefined;
  try {
    // Read it directly rather than inferring from `dir`: "hooksPath set to the default" and
    // "hooksPath unset" resolve identically but are different states to report.
    const raw = execFileSync("git", ["-C", repoRoot, "config", "--get", "core.hooksPath"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (raw) hooksPath = raw;
  } catch {
    /* not a repo, unset, or git absent — leave undefined */
  }

  const exists = existsSync(dir);
  const installed: string[] = [];
  if (exists) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Unreadable hooks dir: report nothing installed rather than guessing.
      entries = [];
    }
    for (const [file, builtin] of Object.entries(BUILTIN_HOOK_FILES)) {
      if (!entries.includes(file)) continue;
      let body: string;
      try {
        body = readFileSync(resolve(dir, file), "utf-8");
      } catch {
        continue;
      }
      // "kit-managed" = the generated marker plus the command it was installed for. A
      // hand-written pre-commit that happens to exist is not kit's floor and is not claimed.
      if (body.includes("Generated by kit") && body.includes(builtin.command)) {
        installed.push(builtin.name);
      }
    }
  }

  const unarmed: string[] = [];
  if (installed.includes("context-check") && !config?.context) unarmed.push("context-check");

  return {
    dir,
    hooksPath,
    external: !isInside(repoRoot, dir),
    exists,
    installed: installed.sort(),
    unarmed,
  };
}

export interface HookFloorVerdict {
  status: "pass" | "warn" | "fail" | "skip";
  severity?: "low" | "medium" | "high";
  detail: string;
}

/**
 * Turn a floor report into a verdict. Exported separately so the policy is one testable
 * decision rather than prose spread across two commands.
 *
 * Ordering is by what an operator must do about it: a gone directory means the floor is OFF, an
 * unarmed gate means it cannot fail, an external floor means it can be removed from outside the
 * repo. Nothing installed and nothing configured is a skip, not a pass — kit does not claim a
 * floor a repo never asked for.
 */
export function judgeHookFloor(report: HookFloorReport): HookFloorVerdict {
  const where = report.hooksPath ? `${report.dir} (core.hooksPath)` : report.dir;

  if (report.hooksPath && !report.exists) {
    return {
      status: "fail",
      severity: "high",
      detail:
        `core.hooksPath points at ${report.dir}, which does not exist — every git hook is OFF, ` +
        `including any kit installed. Unset it (git config --unset core.hooksPath) and re-run ` +
        `'kit hooks add <name>', or recreate the directory.`,
    };
  }
  if (report.installed.length === 0) {
    return {
      status: "skip",
      detail: report.hooksPath
        ? `no kit-managed git hooks in ${where}`
        : "no kit-managed git hooks installed here",
    };
  }
  if (report.unarmed.length > 0) {
    return {
      status: "fail",
      severity: "high",
      detail:
        `${report.unarmed.join(", ")} is installed but cannot fail: no [context] block in .kit.toml, ` +
        `so the pre-push check has nothing to compare the live CLI state against. Declare one ` +
        `('kit context check' prints a starting point) or remove the hook.`,
    };
  }
  if (report.external) {
    return {
      status: "warn",
      severity: "medium",
      detail:
        `the git-hook floor for this repo lives OUTSIDE it, in ${report.dir} (core.hooksPath). ` +
        `Hooks fire, but deleting or moving that directory silently removes the gate. ` +
        `Unset core.hooksPath to keep the floor inside the repo.`,
    };
  }
  return {
    status: "pass",
    detail: `${report.installed.length} kit hook(s) wired in ${where}: ${report.installed.join(", ")}`,
  };
}

/**
 * The OTHER half of the floor: the machine-wide wrapper every hook goes through.
 *
 * `~/.kit/bin/kit` used to be written with whatever entrypoint happened to be running, so one
 * `kit hooks add` from a checkout aimed every hook on the machine at `…/dist/cli.js` — a path
 * `npm run build` deletes on its first step. Measured: a session in an unrelated repo failed with
 * "kit CLI entrypoint missing" and continued UNGATED, because a hook that cannot start is
 * non-blocking (#509). Reporting the hook directory (above) while saying nothing about the
 * wrapper leaves half the floor unmeasured.
 */
export interface WrapperReport {
  path: string;
  /** Present and kit-managed. */
  managed: boolean;
  /** The entrypoint it execs, when it could be read. */
  entry: string | null;
  /** The entrypoint does not exist — every hook on this machine is dead until it returns. */
  entryMissing: boolean;
  /** The entrypoint is inside a git working tree, i.e. a build artifact rather than an install. */
  entryInWorkingTree: boolean;
}

/** Read the wrapper and the state of what it points at. */
export function describeWrapper(home = homedir()): WrapperReport {
  const path = resolve(home, ".kit", "bin", "kit");
  const empty: WrapperReport = {
    path,
    managed: false,
    entry: null,
    entryMissing: false,
    entryInWorkingTree: false,
  };
  let body: string;
  try {
    body = readFileSync(path, "utf-8");
  } catch {
    return empty;
  }
  if (!body.includes("kit-managed wrapper")) return { ...empty, managed: false };
  // The generated wrapper's last line is `exec "<node>" "<cli>" "$@"`.
  const m = /^exec\s+"([^"]+)"\s+"([^"]+)"/m.exec(body);
  const entry = m?.[2] ?? null;
  return {
    path,
    managed: true,
    entry,
    entryMissing: entry !== null && !existsSync(entry),
    entryInWorkingTree: entry !== null && pathInWorkingTree(entry),
  };
}

/**
 * Verdict for the wrapper. A missing entrypoint is the loud case: every kit hook on the machine
 * is dead, in every repo, and it fails open. A working-tree entrypoint is the latent one — it
 * works right now and breaks on the next build.
 */
export function judgeWrapper(r: WrapperReport): HookFloorVerdict {
  if (!r.managed) {
    return { status: "skip", detail: `no kit-managed wrapper at ${r.path}` };
  }
  if (r.entry === null) {
    return {
      status: "warn",
      severity: "medium",
      detail: `${r.path} is kit-managed but its exec target could not be read — refresh it with 'kit agent-config'`,
    };
  }
  if (r.entryMissing) {
    return {
      status: "fail",
      severity: "high",
      detail:
        `the wrapper every kit hook goes through points at ${r.entry}, which does not exist — ` +
        `EVERY kit hook on this machine is dead until it returns, and a hook that cannot start ` +
        `is non-blocking, so sessions run ungated. Refresh it from the installed kit: ` +
        `'kit agent-config' (or 'kit memory install') run from the global binary.`,
    };
  }
  if (r.entryInWorkingTree) {
    return {
      status: "warn",
      severity: "medium",
      detail:
        `the wrapper points at ${r.entry}, inside a git working tree — a build that cleans ` +
        `dist/ will disarm every kit hook on this machine until it finishes. Re-run ` +
        `'kit agent-config' from the installed kit to pin the install instead.`,
    };
  }
  return { status: "pass", detail: `wrapper → ${r.entry}` };
}
