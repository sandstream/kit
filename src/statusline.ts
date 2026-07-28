/**
 * Agent-agnostic status-line emitter. `kit statusline` prints ONE compact, fast,
 * read-only line — setup score for the active mode + an "update available" mark +
 * the open pending-action (PAL) count — that any harness can surface in its info
 * bar (Claude Code `statusLine`, a shell PS1, etc.), with the `kit agent-config`
 * "use kit" block as the universal fallback for harnesses without a native bar.
 *
 * The formatter is pure (fixture-tested); the assembly (`buildStatuslineText`) does
 * only cheap, cached, never-blocking reads (no network on the hot path — see
 * readCachedUpdate). It lives here — not in cli.ts — so the memory SessionStart
 * hook can INJECT the line as context instead of a rules file asking the agent to
 * go run `kit statusline` itself (prose advises; the hook delivers).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig, type kitConfig } from "./config.js";
import { resolveConfigPath } from "./cli-shared.js";
import { resolveMode, modeScore, type SubsystemStatus } from "./setup-modes.js";
import { readCachedUpdateSync, getKitVersionSync } from "./update-check.js";

export interface StatuslineParts {
  mode?: string;
  score?: { done: number; total: number };
  /** latest version string if a newer one is cached (null/undefined = up to date) */
  update?: string | null;
  /** open PAL ("blocked on you") count */
  pal?: number;
  /** The ONE next setup command when adoption is incomplete (e.g. "kit init").
   *  A bare "kit:full 1/6" is true but actionless — the score says something is
   *  missing without saying what to DO, which is how a new repo stays un-kitted. */
  next?: string;
}

/**
 * Render the compact line, e.g. `kit:full 6/6 · ⬆1.34.0 · ⚠2` — or, in an
 * un-adopted repo, `kit:full 1/6 → kit init`. Segments are omitted when empty so
 * an up-to-date repo with no PAL items shows just the score (or nothing).
 * Plain ASCII + three glyphs only — safe in any terminal/harness bar.
 */
export function formatStatusline(p: StatuslineParts): string {
  const seg: string[] = [];
  if (p.score && p.score.total > 0) {
    seg.push(
      p.mode
        ? `kit:${p.mode} ${p.score.done}/${p.score.total}`
        : `kit ${p.score.done}/${p.score.total}`,
    );
  } else if (p.mode) {
    seg.push(`kit:${p.mode}`);
  }
  if (p.update) seg.push(`⬆${p.update}`);
  if (typeof p.pal === "number" && p.pal > 0) seg.push(`⚠${p.pal}`);
  const line = seg.join(" · ");
  // The nudge rides the score segment: only when a score is showing AND incomplete.
  if (p.next && p.score && p.score.total > 0 && p.score.done < p.score.total) {
    return `${line} → ${p.next}`;
  }
  return line;
}

/** Cheap, read-only subsystem presence (file-existence only — no shell/network), for
 *  the statusline + `kit status` score. Safe to run on every prompt render. */
export function quickSubsystems(cwd: string): SubsystemStatus[] {
  const has = (p: string) => existsSync(resolve(cwd, p));
  const tomlHas = (needle: string) => {
    try {
      return readFileSync(resolve(cwd, ".kit.toml"), "utf-8").includes(needle);
    } catch {
      return false;
    }
  };
  // Default memory-db location (avoid importing the sqlite module on the hot path).
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const memoryOk = home ? existsSync(join(home, ".kit", "memory.db")) : false;
  return [
    { key: "config", label: ".kit.toml", ok: has(".kit.toml"), next: "kit init" },
    { key: "tools", label: "tools locked", ok: has(".kit/cli-lock.json"), next: "kit install" },
    { key: "secrets", label: ".env.local", ok: has(".env.local"), next: "kit secrets" },
    {
      key: "hooks",
      label: "git hooks",
      ok: has(".githooks/pre-commit") || has(".git/hooks/pre-commit"),
      next: "kit hooks install",
    },
    {
      key: "agent-config",
      label: "agent config",
      ok: ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".clinerules", "GEMINI.md"].some(has),
      next: "kit agent-config",
    },
    { key: "memory", label: "memory", ok: memoryOk, next: "kit memory install" },
    {
      key: "posture",
      label: "[air_gap]",
      ok: tomlHas("[air_gap]"),
      next: "kit setup --mode airgap",
    },
  ];
}

/** Open-PAL ("blocked on you") count — cheap, 0 on any error. Memory modules are
 *  dynamically imported so the sqlite dependency stays off other commands' startup.
 *  Scoped to the CURRENT project (same definition as `kit memory pal list`) so the
 *  statusline ⚠ and the list can never disagree — an unscoped count once showed
 *  ⚠156 (mostly dead temp-dir scopes) while the list correctly showed 0. */
export async function quickPalCount(cwd?: string): Promise<number> {
  try {
    const { openMemoryDb } = await import("./memory/db.js");
    const { palList } = await import("./memory/pal.js");
    const { getCurrentProjectRoot } = await import("./memory/project.js");
    const db = openMemoryDb();
    try {
      return palList(db, { scope: getCurrentProjectRoot(cwd) }).length;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * Assemble the full statusline text for `cwd`. Shared by `kit statusline` (prints
 * it) and the memory SessionStart hook (injects it as context) so the two surfaces
 * can never drift. Never throws; every input degrades to an omitted segment.
 */
export async function buildStatuslineText(
  opts: { cwd?: string; modeFlag?: string } = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  let config: kitConfig = {} as kitConfig;
  try {
    config = await loadConfig(resolveConfigPath());
  } catch {
    /* no/invalid .kit.toml — statusline still works (mode=full default) */
  }
  const { profile } = resolveMode(opts.modeFlag, config.setup?.mode);
  const { done, total, gaps } = modeScore(profile, quickSubsystems(cwd));
  const update = readCachedUpdateSync(getKitVersionSync());
  return formatStatusline({
    mode: profile.mode,
    score: { done, total },
    update: update?.latest ?? null,
    pal: await quickPalCount(cwd),
    // First gap in subsystem order = the natural next step (config → "kit init"
    // first, so a repo with no .kit.toml is told how to START, not just scored).
    next: gaps[0]?.next,
  });
}
