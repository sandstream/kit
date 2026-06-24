/**
 * kit memory — pure stat derivations (token economy + activity sparkline).
 *
 * These are split out from db.ts so they're fixture-testable without a SQLite
 * handle: db.ts SUMs the raw columns, these functions turn the sums into the
 * ratios + glyphs the CLI prints. Zero I/O, zero deps.
 */
import type { TokenTotals, TokenSummary } from "./types.js";

/**
 * Derive the token economy from summed totals. `totalTokens` is input+output
 * (content generated/consumed); `cacheHitRatio` is the fraction of *input* that
 * was served from the prompt cache.
 *
 * The ratio is null when NO cache tokens were recorded — even if input_tokens is
 * non-zero. Cache columns are forward-only (older rows have NULL cache tokens), so
 * a populated input + zero cache means "not captured", not a true 0% hit rate.
 * Reporting n/a there avoids misrepresenting heavily-cached history as uncached.
 */
export function summarizeTokens(t: TokenTotals): TokenSummary {
  const cacheData = t.cacheReadTokens + t.cacheCreationTokens;
  const cacheBase = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    totalTokens: t.inputTokens + t.outputTokens,
    cacheHitRatio: cacheData > 0 ? t.cacheReadTokens / cacheBase : null,
  };
}

const RAMP = " ░▒▓█";

/**
 * One glyph per day (GitHub-contribution ramp), scaled to the busiest day.
 * Empty input → "". A day with 0 activity is a space; the rest bucket linearly
 * across ░▒▓█ relative to the max. Pure + deterministic.
 */
export function sparkline(counts: number[]): string {
  if (counts.length === 0) return "";
  const max = Math.max(...counts);
  if (max <= 0) return RAMP[0].repeat(counts.length);
  return counts
    .map((n) => {
      if (n <= 0) return RAMP[0];
      // bucket 1..4 (skip the blank glyph for any non-zero day)
      const idx = Math.min(RAMP.length - 1, Math.ceil((n / max) * (RAMP.length - 1)));
      return RAMP[Math.max(1, idx)];
    })
    .join("");
}

/** Human-readable token count: 87_600_000 → "87.6m", 12_345 → "12.3k". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
