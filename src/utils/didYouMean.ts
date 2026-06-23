/**
 * "Did you mean …?" suggestion for mistyped CLI subcommands.
 *
 * Plain Levenshtein with early-out on length difference. Suggestion
 * threshold: distance <= 2 for short names, <= 3 for names longer than
 * 8 chars — tight enough that unrelated commands never surface, loose
 * enough to catch transpositions ("chekc"), drops ("screts") and fat
 * fingers ("securty").
 */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Return the closest candidates to `input`, best first. Empty array when
 * nothing is within the distance threshold.
 */
export function didYouMean(input: string, candidates: string[]): string[] {
  const lower = input.toLowerCase();
  const maxDist = lower.length > 8 ? 3 : 2;
  return candidates
    .map((c) => ({ c, d: levenshtein(lower, c.toLowerCase()) }))
    .filter(({ d }) => d > 0 && d <= maxDist)
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map(({ c }) => c);
}
