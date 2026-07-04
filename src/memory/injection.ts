/**
 * kit memory — prompt-injection pattern scan over the store.
 *
 * The memory store is replayed into the agent's prompt on every session (recall,
 * shared decisions, PAL titles). So a poisoned entry — an "ignore previous
 * instructions", a hidden bidi/zero-width payload, an exfiltration imperative
 * that rode in on some web page the agent read yesterday — is a prompt-injection
 * vector with a delay: today's stored text becomes tomorrow's prompt context.
 *
 * Secret scanners don't look for this. `findInjection` does, mirroring
 * `findSecrets`: deterministic patterns, MASKED short previews, confidence-tiered.
 * Zero-LLM, no model calls — kit finds the shape; a human decides what to do.
 */

export type InjectionConfidence = "high" | "heuristic";

export interface InjectionFinding {
  label: string;
  /** Short, whitespace-normalized preview of the match (never re-injected as an instruction). */
  preview: string;
  confidence: InjectionConfidence;
}

// Invisible characters have no legitimate place in indexed transcript text and
// are the classic way to smuggle an injection payload past a human reviewer —
// high confidence on their own. Codepoints (not regex-literals) so the source
// stays pure ASCII: ZWSP/ZWNJ/ZWJ/word-joiner/BOM, and the bidi
// embedding/override/isolate controls.
const ZERO_WIDTH_CODES = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
const BIDI_CONTROL_CODES = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

// EVERY invisible / format / default-ignorable code point — not a 14-codepoint
// allowlist. Covers the Unicode format category (\p{Cf}: zero-width family, bidi
// controls, word-joiner, BOM, soft hyphen, Mongolian vowel separator, …), the
// TAGS block U+E0000–E007F ("ASCII smuggling"), and both variation-selector
// ranges. These have no legitimate place in indexed transcript text; presence is
// a high-confidence smuggling signal and they are stripped before re-injection.
const UNSAFE_CHAR_SOURCE =
  "[\\p{Cf}\\u{00AD}\\u{FE00}-\\u{FE0F}\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]";
// no-misleading-character-class flags the variation selectors (they can combine
// with a preceding char). That's intentional here: we match each invisible/format
// code point INDIVIDUALLY to strip it, never as part of a grapheme — a combined
// sequence is exactly the smuggling shape we're removing. Disable is scoped + justified.
// eslint-disable-next-line no-misleading-character-class
const UNSAFE_CHAR_RE = new RegExp(UNSAFE_CHAR_SOURCE, "u"); // test (non-global)
// eslint-disable-next-line no-misleading-character-class
const UNSAFE_CHAR_RE_G = new RegExp(UNSAFE_CHAR_SOURCE, "gu"); // strip (global)

function hasCodepoint(text: string, codes: Set<number>): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && codes.has(cp)) return true;
  }
  return false;
}

// Visual look-alikes (Unicode TR39 confusables, ASCII-lookalike subset): Cyrillic
// and Greek letters that render like ASCII Latin. An attacker swaps one per trigger
// token (`іgnore`, `sеcret`, `frоm nоw on`) so a human/agent reads the payload as
// English while the ASCII-literal RULES never fire. Kept as [codepoint, ascii]
// pairs so the source stays pure ASCII (same convention as ZERO_WIDTH_CODES). Folded
// to Latin for MATCHING only — the stored/returned text is never rewritten, so this
// cannot create a false positive against the English rules (folded foreign prose
// only matches if it spells an English trigger, which is exactly the attack).
const CONFUSABLE_PAIRS: ReadonlyArray<readonly [number, string]> = [
  // Cyrillic → Latin (lowercase)
  [0x0430, "a"], [0x0435, "e"], [0x043e, "o"], [0x0440, "p"], [0x0441, "c"],
  [0x0443, "y"], [0x0445, "x"], [0x0456, "i"], [0x0458, "j"], [0x0455, "s"],
  [0x04bb, "h"], [0x0501, "d"],
  // Cyrillic → Latin (uppercase)
  [0x0410, "a"], [0x0412, "b"], [0x0421, "c"], [0x0415, "e"], [0x041d, "h"],
  [0x0406, "i"], [0x0408, "j"], [0x041a, "k"], [0x041c, "m"], [0x041e, "o"],
  [0x0420, "p"], [0x0405, "s"], [0x0422, "t"], [0x0425, "x"], [0x0423, "y"],
  // Greek → Latin (lowercase)
  [0x03b1, "a"], [0x03bf, "o"], [0x03c1, "p"], [0x03bd, "v"], [0x03b9, "i"],
  [0x03ba, "k"],
  // Greek → Latin (uppercase)
  [0x0391, "a"], [0x0392, "b"], [0x0395, "e"], [0x0397, "h"], [0x0399, "i"],
  [0x039a, "k"], [0x039c, "m"], [0x039d, "n"], [0x039f, "o"], [0x03a1, "p"],
  [0x03a4, "t"], [0x03a7, "x"], [0x03a5, "y"], [0x0396, "z"],
];
const CONFUSABLE_MAP = new Map<string, string>(
  CONFUSABLE_PAIRS.map(([cp, a]) => [String.fromCodePoint(cp), a]),
);
const CONFUSABLE_RE = new RegExp(
  "[" + CONFUSABLE_PAIRS.map(([cp]) => "\\u{" + cp.toString(16) + "}").join("") + "]",
  "gu",
);
function foldConfusables(text: string): string {
  return text.replace(CONFUSABLE_RE, (ch) => CONFUSABLE_MAP.get(ch) ?? ch);
}

/** Canonicalize a cell before phrase-rule matching so the rules can't be evaded by:
 *  (a) hidden chars wedged between trigger words, (b) a newline/period split
 *  (whitespace collapsed), (c) NFKC-decomposable look-alikes like FULLWIDTH
 *  `ｉｇｎｏｒｅ`, or (d) Cyrillic/Greek homoglyphs like `іgnore` / `sеcret`. Matching
 *  only — never used for the stored or re-injected text. */
function normalizeForMatch(text: string): string {
  return foldConfusables(stripUnsafeChars(text).normalize("NFKC")).replace(/\s+/g, " ");
}

interface Rule {
  re: RegExp;
  label: string;
  confidence: InjectionConfidence;
}

// Kept deliberately tight: high-confidence rules are the canonical injection
// signatures with low false-positive risk; softer, dual-use shapes are heuristic
// so they inform without crying wolf (kit's no-false-green cuts both ways).
const RULES: Rule[] = [
  {
    // Gaps use [\s\S] (not [^.\n]): findInjection runs rules over the
    // whitespace-collapsed, hidden-char-stripped text, so an attacker can't split
    // "ignore … instructions" across a newline or a period to slip the phrase past.
    re: /\b(ignore|disregard|forget)\b[\s\S]{0,40}\b(previous|prior|above|earlier|all)\b[\s\S]{0,25}\b(instructions?|prompts?|rules?|directions?|context)\b/i,
    label: "instruction-override",
    confidence: "high",
  },
  { re: /\bnew\s+instructions?\s*:/i, label: "new-instructions", confidence: "high" },
  { re: /\b(you are now|from now on,? you)\b/i, label: "role-reprogram", confidence: "high" },
  {
    re: /\b(system prompt|developer message|assistant message)\b/i,
    label: "prompt-role-ref",
    confidence: "heuristic",
  },
  {
    // "high": an imperative pairing an exfil verb with a secret noun in one span is
    // a canonical data-theft injection — it must QUARANTINE (db.ts) and FLAG on
    // recall (sanitizeForPrompt), not merely inform.
    re: /\b(exfiltrat\w*|send|leak|upload|post|email)\b[\s\S]{0,40}\b(secret|token|password|api[_-]?key|credential|\.env|ssh key|private key)\b/i,
    label: "exfil-imperative",
    confidence: "high",
  },
  {
    // "high": curl-pipe-to-shell is unambiguous remote code execution; a stored
    // entry replaying it into the prompt is an attack, not a dual-use hint.
    re: /\bcurl\b[^|]{0,150}\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
    label: "pipe-to-shell",
    confidence: "high",
  },
];

function preview(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 48);
}

/**
 * Remove invisible zero-width + bidi-control characters from text that is about to
 * be re-injected into the agent's prompt (recall, decisions, PAL titles). These
 * chars carry no legitimate meaning in that context and are the classic way to
 * hide an injection payload from a human reviewer — stripping them defangs the
 * hidden-payload vector deterministically. Visible text is left untouched.
 */
export function stripUnsafeChars(text: string): string {
  if (!text) return text;
  // Strip EVERY invisible/format/default-ignorable code point, not just the
  // 14-codepoint zero-width+bidi allowlist: \p{Cf}, soft hyphen, variation
  // selectors, and the TAGS block (ASCII smuggling) all get removed before
  // re-injection. The named ZERO_WIDTH_CODES/BIDI_CONTROL_CODES sets are retained
  // only so findInjection can attribute a specific label to those two families.
  return text.replace(UNSAFE_CHAR_RE_G, "");
}

export interface SanitizedText {
  /** Hidden-char-stripped text, safe to place inside a DATA block. */
  text: string;
  /** True when a HIGH-confidence injection pattern is present (hidden chars or a
   *  canonical override/role-reprogram phrase) — the caller should mark it as
   *  suspect and never treat it as an instruction. */
  flagged: boolean;
}

/**
 * Prepare ONE stored text cell for RE-INJECTION into the prompt. This is the single
 * chokepoint every replay path (SessionStart recovery, the UserPromptSubmit nudge,
 * `kit memory search` render, shared-tier render) should route store-derived text
 * through: it (a) strips hidden zero-width/bidi chars and (b) FLAGS high-confidence
 * injection phrases so the surface can badge them as data rather than silently
 * replaying "ignore all previous instructions …" as if kit had said it. Flagging is
 * computed on the ORIGINAL text (so hidden-char payloads count) but the returned
 * text is stripped. Deterministic, zero-LLM. kit flags; the human/agent decides.
 */
export function sanitizeForPrompt(text: string): SanitizedText {
  const raw = text ?? "";
  const flagged = findInjection(raw).some((f) => f.confidence === "high");
  return { text: stripUnsafeChars(raw), flagged };
}

/**
 * Deterministic injection-pattern findings in a single text cell. Invisible-char
 * hits first (strongest signal), then the phrase rules. One finding per label per
 * cell (cross-cell dedup + attribution happens in `scanDbForInjection`).
 */
export function findInjection(text: string): InjectionFinding[] {
  if (!text) return [];
  const out: InjectionFinding[] = [];
  const seenZeroWidth = hasCodepoint(text, ZERO_WIDTH_CODES);
  const seenBidi = hasCodepoint(text, BIDI_CONTROL_CODES);
  if (seenZeroWidth) {
    out.push({
      label: "zero-width-char",
      preview: "hidden zero-width char(s) (U+200B family)",
      confidence: "high",
    });
  }
  if (seenBidi) {
    out.push({
      label: "bidi-control",
      preview: "hidden bidirectional override char(s)",
      confidence: "high",
    });
  }
  // Any OTHER invisible/format/default-ignorable char (variation selectors, the
  // TAGS block used for ASCII smuggling, soft hyphen, …) that the two named
  // families above didn't already attribute. These never belong in transcript
  // text — presence alone is a high-confidence smuggling signal.
  if (!seenZeroWidth && !seenBidi && UNSAFE_CHAR_RE.test(text)) {
    out.push({
      label: "hidden-format-char",
      preview: "hidden format/invisible char(s) (ASCII smuggling)",
      confidence: "high",
    });
  }
  // Match phrase rules over the normalized view: hidden chars stripped and
  // whitespace collapsed, so a newline/period/zero-width char wedged between
  // trigger words can't split the phrase past the rule.
  const normalized = normalizeForMatch(text);
  for (const { re, label, confidence } of RULES) {
    const m = normalized.match(re);
    if (m) out.push({ label, preview: preview(m[0]), confidence });
  }
  return out;
}
