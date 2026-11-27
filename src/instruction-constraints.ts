/**
 * Instruction constraints: the rule lines of agent instruction files, the code tokens they name,
 * and how a rule line changed since the last commit.
 *
 * A rule line ("Never call `legacyHandler()`", "Always run `scripts/sync.sh` first") protects or
 * requires a piece of code. Two things break it without anyone deciding to:
 *   - the code it names is deleted (a dead-code cut treats prose as non-use), so the rule now
 *     constrains nothing;
 *   - the line itself is deleted or softened ("never" to "avoid") by an agent edit, a compressor
 *     or a block rewrite.
 * This module is the pure half: classify lines and tokens, and compare two versions of a file's
 * rule lines. `instruction-constraints-repo.ts` reads the tree and git. Text over text, no model
 * (ADR-0001). The rule words extend the ones `skill-rule-gates.ts` reads with `must` and `only`.
 */
import { CODE_TOKEN, CODE_SHAPE, RULE_WORD_SV, isRuleLine } from "./skill-rule-gates.js";

const CONSTRAINT_EXTRA = /\b(must|only)\b/i;
/** A line that forbids: absence of what it names may be the rule being obeyed. */
const PROHIBITIVE = /\b(never|must not|mustn't|do not|don't|forbid(?:den)?|avoid)\b/i;

export const isConstraintLine = (text: string): boolean =>
  isRuleLine(text) || CONSTRAINT_EXTRA.test(text);

export type TokenKind = "path" | "identifier" | "env";

export interface ConstraintToken {
  kind: TokenKind;
  /** The text as written between backticks. */
  token: string;
  /** What is looked up: a path without glob tail or line suffix, or the identifier's last name. */
  probe: string;
}

export interface ConstraintRef extends ConstraintToken {
  file: string;
  line: number;
  prohibitive: boolean;
}

const FILE_EXT =
  /\.(md|mdc|ts|tsx|js|jsx|mjs|cjs|json|jsonc|toml|ya?ml|py|rs|go|rb|sh|ps1|cmd|bat|txt|lock|cfg|ini|html|css|scss|sql|java|kt|cs|c|h|cc|cpp|hpp|php|swift|xml|gradle|vue|svelte|proto)$/i;
const ENV_NAME = /^\$?\{?([A-Z][A-Z0-9]*_[A-Z0-9_]+)\}?$|^\$([A-Z][A-Z0-9_]*)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*$/;

/** Commands, URLs, flags, placeholders, absolute or home paths, versions and package specs. */
function obviouslyNotCode(token: string): boolean {
  return (
    /\s/.test(token) ||
    /:\/\/|^www\.|^[\w.+-]+@[\w-]+\./.test(token) ||
    /[<>{}|…"'=]|\.\.\./.test(token.replace(/^\$\{|\}$/g, "")) ||
    /^[-/~%@!]|^[A-Za-z]:\\|^\$HOME/.test(token) ||
    /^v?\d/.test(token)
  );
}

function pathToken(token: string): ConstraintToken | null {
  const cleaned = token.replace(/:\d+(?:-\d+)?$/, "");
  if (/^[\w-]+:(?!\\)/.test(cleaned)) return null; // node:path, npm:typescript
  const dotfile = /^\.[\w-][\w.*-]*$/.test(cleaned);
  if (!cleaned.includes("/") && !cleaned.includes("\\") && !dotfile && !FILE_EXT.test(cleaned)) {
    return null;
  }
  const glob = cleaned.search(/[*?[]/);
  const stem = glob === -1 ? cleaned : cleaned.slice(0, glob).replace(/[^/\\]*$/, "");
  const probe = stem.replace(/\\/g, "/").replace(/\/+$/, "");
  return probe ? { kind: "path", token, probe } : null;
}

/**
 * What a backticked token names, or null when it is a command, URL, placeholder, flag or a plain
 * word. Only tokens shaped like code are kept: a path (a separator, a dotfile or a known file
 * extension), an env var (`UPPER_SNAKE`, `$NAME`), or an identifier with a call, a dot, `::`, an
 * underscore or camelCase.
 */
export function classifyToken(raw: string): ConstraintToken | null {
  const token = raw.trim();
  const env = ENV_NAME.exec(token);
  if (env) return { kind: "env", token, probe: (env[1] ?? env[2])! };
  if (obviouslyNotCode(token)) return null;
  const path = pathToken(token);
  if (path) return path;
  const name = token.replace(/\(\)$|\([^()]*\)$/, "");
  if (!IDENTIFIER.test(name) || !CODE_SHAPE.test(token)) return null;
  const probe = name.split(/\.|::|#/).pop()!;
  return probe.length >= 3 ? { kind: "identifier", token, probe } : null;
}

/** Each constraint line's code tokens, outside fenced code blocks. */
export function constraintRefs(file: string, text: string): ConstraintRef[] {
  const out: ConstraintRef[] = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || !isConstraintLine(line)) return;
    // Every Swedish rule word skill-rule-gates reads is a prohibition.
    const prohibitive = PROHIBITIVE.test(line) || RULE_WORD_SV.test(line);
    for (const m of line.matchAll(CODE_TOKEN)) {
      const t = classifyToken(m[1]!);
      if (t) out.push({ ...t, file, line: i + 1, prohibitive });
    }
  });
  return out;
}

// --- Against the previous version -------------------------------------------------------------

const STRONG = ["must not", "mustn't", "do not", "don't", "never", "always", "must", "only"];
const WEAK = [
  "prefer not to",
  "prefer not",
  "try not to",
  "should not",
  "shouldn't",
  "try to",
  "avoid",
  "should",
  "consider",
  "ideally",
  "prefer",
];
const STRENGTH = new RegExp(
  `\\b(${[...STRONG, ...WEAK].sort((a, b) => b.length - a.length).join("|")})\\b`,
  "gi",
);
const STRONG_WORD = new RegExp(`\\b(${STRONG.join("|")})\\b`, "i");

/** A rule line as compared: no list marker or emphasis, one space, lower case. */
function normalizeRuleLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+>]|\d+[.)]|#+)\s+/, "")
    .replace(/[*_]{1,2}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const strengthKey = (normalized: string): string => normalized.replace(STRENGTH, "§");
const strongWord = (line: string): string | undefined => STRONG_WORD.exec(line)?.[1]?.toLowerCase();

export interface RuleChange {
  file: string;
  /** The line number in the committed version. */
  line: number;
  kind: "removed" | "weakened";
  excerpt: string;
  /** For `weakened`: the strong word before and the line after. */
  from?: string;
  to?: string;
}

const WEAK_WORD = new RegExp(`\\b(${WEAK.join("|")})\\b`, "i");
/** Words of a rule line without its strength words and with `-ing` folded (build, building). */
const contentWords = (normalized: string): Set<string> =>
  new Set(
    strengthKey(normalized)
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
      .map((w) => w.replace(/ing$/, "")),
  );

function similar(a: Set<string>, b: Set<string>): boolean {
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared || 1) >= 0.6;
}

/** A current line that says nearly the same thing and keeps the strong word: the rule stayed. */
function reworded(before: string, strong: string, candidates: string[]): boolean {
  const words = contentWords(normalizeRuleLine(before));
  return candidates.some((c) => {
    const n = normalizeRuleLine(c);
    return strongWord(n) === strong && similar(words, contentWords(n));
  });
}

/** The current line that says the same thing with a weak word in place of the strong one. */
function weakenedTo(before: string, candidates: string[]): string | undefined {
  const words = contentWords(normalizeRuleLine(before));
  return candidates.find((c) => {
    const n = normalizeRuleLine(c);
    return WEAK_WORD.test(n) && !strongWord(n) && similar(words, contentWords(n));
  });
}

/**
 * The committed file's strong rule lines that the working tree's version no longer holds. A line
 * still in the same file was moved, not removed; one moved to another file is removed here, because
 * each harness reads its own file (Claude Code reads `CLAUDE.md`, not `AGENTS.md`). A line whose
 * strong word became a weak one ("never" to "avoid", "prefer not") is `weakened`. A near-identical
 * line that keeps the strong word (three in five content words shared) is a rewording and not
 * listed; any other missing line is `removed`.
 */
export function ruleChanges(file: string, committed: string, current: string | null): RuleChange[] {
  const currentLines = current === null ? [] : current.split(/\r?\n/);
  const present = new Set(currentLines.map(normalizeRuleLine));
  const out: RuleChange[] = [];
  committed.split(/\r?\n/).forEach((text, i) => {
    const strong = strongWord(text);
    if (!strong || !isConstraintLine(text)) return;
    const normalized = normalizeRuleLine(text);
    if (!normalized || present.has(normalized) || reworded(text, strong, currentLines)) return;
    const excerpt = text.trim().slice(0, 160);
    const to = weakenedTo(text, currentLines);
    if (to) out.push({ file, line: i + 1, kind: "weakened", excerpt, from: strong, to: to.trim() });
    else out.push({ file, line: i + 1, kind: "removed", excerpt });
  });
  return out;
}
