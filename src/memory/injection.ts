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

function hasCodepoint(text: string, codes: Set<number>): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && codes.has(cp)) return true;
  }
  return false;
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
    re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,25}\b(instructions?|prompts?|rules?|directions?|context)\b/i,
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
    re: /\b(exfiltrat\w*|send|leak|upload|post|email)\b[^.\n]{0,40}\b(secret|token|password|api[_-]?key|credential|\.env|ssh key|private key)\b/i,
    label: "exfil-imperative",
    confidence: "heuristic",
  },
  {
    re: /\bcurl\b[^\n|]{0,150}\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
    label: "pipe-to-shell",
    confidence: "heuristic",
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
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && (ZERO_WIDTH_CODES.has(cp) || BIDI_CONTROL_CODES.has(cp))) continue;
    out += ch;
  }
  return out;
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
  if (hasCodepoint(text, ZERO_WIDTH_CODES)) {
    out.push({
      label: "zero-width-char",
      preview: "hidden zero-width char(s) (U+200B family)",
      confidence: "high",
    });
  }
  if (hasCodepoint(text, BIDI_CONTROL_CODES)) {
    out.push({
      label: "bidi-control",
      preview: "hidden bidirectional override char(s)",
      confidence: "high",
    });
  }
  for (const { re, label, confidence } of RULES) {
    const m = text.match(re);
    if (m) out.push({ label, preview: preview(m[0]), confidence });
  }
  return out;
}
