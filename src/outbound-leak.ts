/**
 * Private agent instructions leaking into outbound text (OWASP LLM07, system prompt leakage), found
 * by character n-gram overlap: the method PyRIT's SystemPromptExtractionScorer describes, written
 * here from that description. For a coding agent the "system prompt" is its instruction files, so
 * the text measured is a PR body, commit message or release note against the instruction files the
 * repository does not publish.
 *
 * Deterministic and pure: no model, no network, no file access (the sources live in
 * outbound-leak-sources.ts). Both sides are normalised (case, whitespace, markdown emphasis), every
 * 16-character n-gram of the outbound text is indexed, and each private file is walked once: a
 * shared n-gram anchors a span, which grows while the characters agree. Parts of a span that also
 * occur in a public instruction file are dropped, so shared boilerplate is not a leak, and what is
 * left counts only from `minChars` characters up.
 */
import { redactSecrets } from "./utils/redactSecrets.js";

/** The n-gram length that anchors a span. A shorter span than this cannot be found. */
export const GRAM = 16;
export const DEFAULT_MIN_CHARS = 40;
/** The most characters of a span ever printed. */
export const SPAN_DISPLAY_MAX = 120;
/** Positions kept per outbound n-gram: repeated text cannot make the walk quadratic. */
const MAX_HITS_PER_GRAM = 64;
/** Markdown markers dropped on both sides, so `**Never** push` matches `never push`. */
const MARKUP = new Set(["*", "`", "#", ">"]);

/** Text normalised for matching, with the 1-based source line of every character. */
export interface Normalised {
  text: string;
  lines: number[];
}

/** Lower-case, drop markdown markers, and collapse every whitespace run to one space. Pure. */
export function normalise(raw: string): Normalised {
  const out: string[] = [];
  const lines: number[] = [];
  let line = 1;
  let space = false;
  for (const ch of raw) {
    if (/\s/u.test(ch)) {
      if (out.length > 0 && !space) space = true;
      if (ch === "\n") line++;
      continue;
    }
    if (MARKUP.has(ch)) continue;
    if (space) {
      out.push(" ");
      lines.push(line);
      space = false;
    }
    for (const lower of ch.toLowerCase()) {
      out.push(lower);
      lines.push(line);
    }
  }
  return { text: out.join(""), lines };
}

/** One private file, as shown to the user (`CLAUDE.local.md`, `~/.claude/CLAUDE.md`). */
export interface PrivateSource {
  shown: string;
  text: string;
}

export interface LeakFinding {
  file: string;
  line: number;
  endLine: number;
  chars: number;
  /** The outbound span, redacted and capped at SPAN_DISPLAY_MAX characters. */
  span: string;
  /** Share of the private file's normalised characters that the outbound text repeats. */
  share: number;
}

interface Span {
  o: number;
  p: number;
  len: number;
}

function gramIndex(text: string): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i + GRAM <= text.length; i++) {
    const gram = text.slice(i, i + GRAM);
    const hits = index.get(gram);
    if (!hits) index.set(gram, [i]);
    else if (hits.length < MAX_HITS_PER_GRAM) hits.push(i);
  }
  return index;
}

/** Every maximal common run of `out` and `priv` that an n-gram anchors, once per diagonal. */
function commonSpans(out: string, index: Map<string, number[]>, priv: string): Span[] {
  const reach = new Map<number, number>();
  const spans: Span[] = [];
  for (let p = 0; p + GRAM <= priv.length; p++) {
    const hits = index.get(priv.slice(p, p + GRAM));
    if (!hits) continue;
    for (const o of hits) {
      const diagonal = o - p;
      if ((reach.get(diagonal) ?? -1) > o) continue;
      let len = GRAM;
      while (o + len < out.length && p + len < priv.length && out[o + len] === priv[p + len]) len++;
      reach.set(diagonal, o + len);
      spans.push({ o, p, len });
    }
  }
  return spans;
}

/** Every n-gram of the public instruction texts. */
function publicGrams(publicTexts: readonly string[]): Set<string> {
  const grams = new Set<string>();
  for (const raw of publicTexts) {
    const { text } = normalise(raw);
    for (let i = 0; i + GRAM <= text.length; i++) grams.add(text.slice(i, i + GRAM));
  }
  return grams;
}

/** The parts of `span` no public n-gram covers, from `minChars` characters up. */
function privateRuns(out: string, span: Span, pub: Set<string>, minChars: number): Span[] {
  const covered = new Uint8Array(span.len);
  for (let k = 0; k + GRAM <= span.len; k++) {
    if (pub.has(out.slice(span.o + k, span.o + k + GRAM))) covered.fill(1, k, k + GRAM);
  }
  const runs: Span[] = [];
  let start = -1;
  for (let k = 0; k <= span.len; k++) {
    const open = k < span.len && covered[k] === 0;
    if (open && start < 0) start = k;
    if (!open && start >= 0) {
      if (k - start >= minChars)
        runs.push({ o: span.o + start, p: span.p + start, len: k - start });
      start = -1;
    }
  }
  return runs;
}

/** Longest first, dropping any span whose outbound range overlaps one already kept. */
function distinct(spans: Span[]): Span[] {
  const kept: Span[] = [];
  for (const s of [...spans].sort((a, b) => b.len - a.len || a.o - b.o)) {
    if (!kept.some((k) => s.o < k.o + k.len && k.o < s.o + s.len)) kept.push(s);
  }
  return kept.sort((a, b) => a.o - b.o);
}

/** The span as printed: redacted first, so a cap never splits a secret, then capped. Pure. */
export function displaySpan(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > SPAN_DISPLAY_MAX
    ? `${redacted.slice(0, SPAN_DISPLAY_MAX - 1)}…`
    : redacted;
}

/** Every span of `outbound` that repeats a private file, past `minChars`. Pure. */
export function findInstructionLeaks(
  outbound: string,
  privates: readonly PrivateSource[],
  publicTexts: readonly string[],
  minChars = DEFAULT_MIN_CHARS,
): LeakFinding[] {
  const min = Math.max(minChars, GRAM);
  const out = normalise(outbound).text;
  const index = gramIndex(out);
  const pub = publicGrams(publicTexts);
  const findings: LeakFinding[] = [];
  for (const source of privates) {
    const priv = normalise(source.text);
    const runs = distinct(
      commonSpans(out, index, priv.text).flatMap((s) => privateRuns(out, s, pub, min)),
    );
    const repeated = runs.reduce((sum, r) => sum + r.len, 0);
    const share = priv.text.length ? Math.round((repeated / priv.text.length) * 1000) / 1000 : 0;
    for (const r of runs) {
      findings.push({
        file: source.shown,
        line: priv.lines[r.p] ?? 1,
        endLine: priv.lines[r.p + r.len - 1] ?? 1,
        chars: r.len,
        span: displaySpan(out.slice(r.o, r.o + r.len)),
        share,
      });
    }
  }
  return findings;
}
