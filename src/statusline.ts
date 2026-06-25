/**
 * Agent-agnostic status-line emitter. `kit statusline` prints ONE compact, fast,
 * read-only line — setup score for the active mode + an "update available" mark +
 * the open pending-action (PAL) count — that any harness can surface in its info
 * bar (Claude Code `statusLine`, a shell PS1, etc.), with the `kit agent-config`
 * "use kit" block as the universal fallback for harnesses without a native bar.
 *
 * The formatter is pure (fixture-tested); the command does only cheap, cached,
 * never-blocking reads (no network on the hot path — see readCachedUpdate).
 */

export interface StatuslineParts {
  mode?: string;
  score?: { done: number; total: number };
  /** latest version string if a newer one is cached (null/undefined = up to date) */
  update?: string | null;
  /** open PAL ("blocked on you") count */
  pal?: number;
}

/**
 * Render the compact line, e.g. `kit:full 6/6 · ⬆1.34.0 · ⚠2`. Segments are omitted
 * when empty so an up-to-date repo with no PAL items shows just the score (or
 * nothing). Plain ASCII + two glyphs only — safe in any terminal/harness bar.
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
  return seg.join(" · ");
}
