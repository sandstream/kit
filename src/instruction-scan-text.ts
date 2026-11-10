/** Instruction text rules and display text. File discovery belongs to the caller. */
import { findInjection } from "./memory/injection.js";
import { extraInstructionRules } from "./instruction-rules.js";
import { hasExecAfterDownload, hasSecretOutbound } from "./instruction-scan-patterns.js";
import { sanitizeDisplayText as sanitizeInstructionDisplay } from "./display-text.js";
export { sanitizeDisplayText as sanitizeInstructionDisplay } from "./display-text.js";

export type InstructionRule =
  "secret-to-outbound" | "exec-after-download" | "conceal-from-user" | `injection:${string}`;

export interface InstructionFinding {
  file: string;
  line: number;
  rule: InstructionRule;
  /** Display text with secrets and terminal controls removed, at most 160 characters. */
  excerpt: string;
}

const WHO = "(?:the\\s+)?(?:user|human|operator|owner|reviewer)s?";
const CONCEAL = new RegExp(
  `\\b(?:never|don'?t|do not|without)\\s+(?:tell(?:ing)?|inform(?:ing)?|notify(?:ing)?|alert(?:ing)?)\\s+${WHO}\\s+(?:about|that|of)\\b` +
    `|\\b(?:never|don'?t|do not|without)\\s+(?:mention(?:ing)?|reveal(?:ing)?|show(?:ing)?)\\s+(?:\\S+\\s+){0,4}to\\s+${WHO}\\b`,
  "i",
);

/** The display form of a source line. It is the costly part of a finding: three secret passes. */
function excerptOf(raw: string): string {
  const clean = sanitizeInstructionDisplay(raw);
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
}

/**
 * Locate a full-text label absent from every individual line.
 * Search at line boundaries: a character prefix could manufacture a word boundary inside a word.
 * First find the earliest complete match, then its latest possible start line.
 */
function multilineStart(text: string, starts: number[], label: string): number {
  const hasLabel = (start: number, end: number): boolean =>
    findInjection(text.slice(starts[start], starts[end] ?? text.length)).some(
      (f) => f.confidence === "high" && f.label === label,
    );
  let low = 1;
  let high = starts.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (hasLabel(0, mid)) high = mid;
    else low = mid + 1;
  }
  const end = low;
  low = 0;
  high = end - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (hasLabel(mid, end)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Rules of one line, injection labels first. An added rule is not reported twice for the line. */
function lineRules(raw: string, labels: string[]): InstructionRule[] {
  const rules: InstructionRule[] = labels.map((label) => `injection:${label}` as const);
  if (hasSecretOutbound(raw)) rules.push("secret-to-outbound");
  if (hasExecAfterDownload(raw)) rules.push("exec-after-download");
  if (CONCEAL.test(raw)) rules.push("conceal-from-user");
  for (const rule of extraInstructionRules(raw)) if (!rules.includes(rule)) rules.push(rule);
  return rules;
}

/**
 * Yield each per-line result, then full-text labels absent from those results.
 * The caller can stop at its finding budget. No complete result array is allocated.
 */
export function* instructionFindings(file: string, text: string): Generator<InstructionFinding> {
  const represented = new Set<string>();
  const starts: number[] = [];
  let start = 0;
  while (start <= text.length) {
    starts.push(start);
    const newline = text.indexOf("\n", start);
    const raw = text.slice(start, newline < 0 ? text.length : newline).replace(/\r$/, "");
    const line = starts.length;
    const labels = findInjection(raw)
      .filter((f) => f.confidence === "high")
      .map((f) => f.label);
    for (const label of labels) represented.add(label);
    // One line can match several rules. Its excerpt is the same for each, so build it once.
    let excerpt: string | undefined;
    for (const rule of lineRules(raw, labels)) {
      excerpt ??= excerptOf(raw);
      yield { file, line, rule, excerpt };
    }
    if (newline < 0) break;
    start = newline + 1;
  }

  for (const f of findInjection(text)) {
    if (f.confidence !== "high" || represented.has(f.label)) continue;
    const index = multilineStart(text, starts, f.label);
    const raw = text.slice(starts[index], starts[index + 1] ?? text.length).replace(/\r?\n$/, "");
    yield { file, line: index + 1, rule: `injection:${f.label}`, excerpt: excerptOf(raw) };
  }
}

/** Compatible eager interface for callers that need every result. */
export function scanInstructionText(file: string, text: string): InstructionFinding[] {
  return [...instructionFindings(file, text)];
}
