/**
 * Repo-map — co-change coupling (Pillar 4, deterministic / zero-LLM).
 *
 * Files that keep changing together are coupled even when nothing imports them across (a schema and
 * its migration, a component and its test, a config and its consumer). This module turns git history
 * into that signal: parse `git log --name-only`, count how often each file pair appears in the same
 * commit, and surface a seed's top co-changed files. Pure (the command does the git I/O, feeds the
 * text here); deterministic given the history window.
 */

/** Unit-separator that precedes each commit's hash in our `git log --format` (robust block split). */
export const COCHANGE_SEP = "\x1f";

/**
 * Parse `git log --name-only --format=<SEP>%H` output into one file-path list per commit. Commits
 * touching more than `maxFilesPerCommit` files are skipped (mega-commits are coupling noise and blow
 * up the pair count). Pure and order-preserving.
 */
export function parseCoChangeLog(raw: string, maxFilesPerCommit = 50): string[][] {
  const sets: string[][] = [];
  for (const block of raw.split(COCHANGE_SEP)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const files = lines
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);
    if (files.length >= 2 && files.length <= maxFilesPerCommit) sets.push(files);
  }
  return sets;
}

/**
 * Count how often each unordered file pair co-occurs across the commit file-sets. Returned as an
 * adjacency map: `file → (other → count)`. Pure and deterministic.
 */
export function coChangeCounts(commitFileSets: string[][]): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string) => {
    let row = counts.get(a);
    if (!row) {
      row = new Map();
      counts.set(a, row);
    }
    row.set(b, (row.get(b) ?? 0) + 1);
  };
  for (const files of commitFileSets) {
    const uniq = [...new Set(files)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        bump(uniq[i], uniq[j]);
        bump(uniq[j], uniq[i]);
      }
    }
  }
  return counts;
}

export interface CoChange {
  file: string;
  count: number;
}

/**
 * A file's top co-changed partners, most-frequent first (path tie-break), capped at `topN` and to
 * pairs seen at least `minCount` times (default 2 — a single shared commit is not a signal). Pure.
 */
export function topCoChanged(
  counts: Map<string, Map<string, number>>,
  file: string,
  topN = 5,
  minCount = 2,
): CoChange[] {
  const row = counts.get(file);
  if (!row) return [];
  return [...row.entries()]
    .filter(([, n]) => n >= minCount)
    .map(([f, count]) => ({ file: f, count }))
    .sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, topN);
}
