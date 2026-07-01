/**
 * kit memory learn — deterministically mine the store for RECURRING user
 * instructions worth promoting to a memory rule.
 *
 * Zero-LLM, local, no ML: kit *finds* the pattern by counting verbatim-normalized
 * user messages; *you* decide the rule (record it via `kit memory share` or your
 * rules file). Idea borrowed from headroom's `learn` (kit-research), done the kit
 * way — pure counting over the local store, no model call.
 *
 * The signal: a user who says the same thing 3+ times (across sessions, or over
 * and over in one) is telling you something that belongs in memory instead of
 * being re-typed. A message flagged `correction` (it reads like a redirection —
 * "no", "stop", "instead", "nej", "istället") is an even stronger candidate.
 */
import type { DatabaseSync } from "node:sqlite";

export interface LearnCandidate {
  /** Normalized instruction text — the grouping key. */
  normalized: string;
  /** A representative original message (first seen, trimmed). */
  example: string;
  /** Total occurrences across the store. */
  count: number;
  /** Distinct sessions it appeared in — the cross-session recurrence signal. */
  sessions: number;
  /** True if it reads like a correction/redirection (bilingual sv/en). */
  correction: boolean;
}

export interface LearnOptions {
  /** Min total occurrences for a candidate (default 3). */
  minCount?: number;
  /** Min distinct sessions (default 1 — off; raise to require cross-session). */
  minSessions?: number;
  /** Max candidates returned (default 20). */
  limit?: number;
}

// Correction / redirection signals — bilingual (this user works in sv + en).
// Word-boundary anchored so "not" doesn't fire inside "notation".
const CORRECTION_RE =
  /\b(no|nope|don'?t|stop|actually|wrong|instead|not that|nej|sluta|fel|inte|istället|igen)\b/i;

/**
 * Normalize a user message to a grouping key: lowercase, strip markdown/punctuation,
 * collapse whitespace. Two messages that differ only in casing or punctuation group
 * together; substantively different messages do not.
 */
export function normalizeInstruction(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[`*_>#[\](){}"'.,!?;:/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rank recurring user instructions. Groups user messages by their normalized text,
 * keeps those seen `minCount`+ times (and in `minSessions`+ distinct sessions), and
 * ranks by distinct sessions, then raw count, then correction-first. Very short
 * (< 3 words: "ok", "kör", "yes") and very long (> 50 words: one-off context dumps)
 * messages are skipped — neither is a repeatable instruction.
 */
export function learnRecurring(db: DatabaseSync, opts: LearnOptions = {}): LearnCandidate[] {
  const minCount = opts.minCount ?? 3;
  const minSessions = opts.minSessions ?? 1;
  const limit = opts.limit ?? 20;

  const rows = db
    .prepare(
      `SELECT content, session_id FROM messages
       WHERE type = 'user' AND content IS NOT NULL AND content != ''`,
    )
    .all() as { content: string; session_id: string }[];

  const groups = new Map<string, { example: string; count: number; sessions: Set<string> }>();
  for (const r of rows) {
    const normalized = normalizeInstruction(r.content);
    const words = normalized.split(" ").filter(Boolean);
    if (words.length < 3 || words.length > 50) continue;
    let g = groups.get(normalized);
    if (!g) {
      g = { example: r.content.replace(/\s+/g, " ").trim(), count: 0, sessions: new Set() };
      groups.set(normalized, g);
    }
    g.count++;
    g.sessions.add(r.session_id);
  }

  const candidates: LearnCandidate[] = [];
  for (const [normalized, g] of groups) {
    if (g.count < minCount || g.sessions.size < minSessions) continue;
    candidates.push({
      normalized,
      example: g.example.slice(0, 200),
      count: g.count,
      sessions: g.sessions.size,
      correction: CORRECTION_RE.test(normalized),
    });
  }
  candidates.sort(
    (a, b) =>
      b.sessions - a.sessions || b.count - a.count || Number(b.correction) - Number(a.correction),
  );
  return candidates.slice(0, limit);
}
