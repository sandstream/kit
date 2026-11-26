const BLOCK_OPEN = String.fromCharCode(47, 42);
const BLOCK_CLOSE = String.fromCharCode(42, 47);
const LINE_COMMENT = String.fromCharCode(45, 45);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);

/** What a lexer step consumed: the index after it and the text it leaves behind. */
type Skip = { end: number; keep: string; unterminated?: true };

function skipLineComment(text: string, i: number): Skip | null {
  if (!text.startsWith(LINE_COMMENT, i)) return null;
  const nl = text.indexOf("\n", i);
  return { end: nl === -1 ? text.length : nl, keep: " " };
}

function skipBlockComment(text: string, i: number): Skip | null {
  if (!text.startsWith(BLOCK_OPEN, i)) return null;
  let depth = 0;
  let at = i;
  while (at < text.length) {
    if (text.startsWith(BLOCK_OPEN, at)) {
      depth++;
      at += 2;
    } else if (text.startsWith(BLOCK_CLOSE, at)) {
      depth--;
      at += 2;
      if (depth === 0) return { end: at, keep: " " };
    } else {
      at++;
    }
  }
  return { end: text.length, keep: " ", unterminated: true };
}

function isIdentChar(ch: string | undefined): boolean {
  return ch === "$" || isTagChar(ch, false);
}

/** An E string (a lone E or e right before the quote) treats a backslash as an escape. */
function isEscapeString(text: string, i: number): boolean {
  const before = text[i - 1];
  return (before === "E" || before === "e") && !isIdentChar(text[i - 2]);
}

/** A quoted run, with a doubled quote as the escape. A string loses its content, an identifier keeps it. */
function skipQuoted(text: string, i: number, quote: string): Skip | null {
  if (text[i] !== quote) return null;
  const backslash = quote === SQ && isEscapeString(text, i);
  let at = i + 1;
  while (at < text.length) {
    if (backslash && text[at] === "\\") at += 2;
    else if (text[at] === quote && text[at + 1] === quote) at += 2;
    else if (text[at] === quote) break;
    else at++;
  }
  const closed = at < text.length;
  const end = Math.min(at + 1, text.length);
  const keep = quote === SQ ? SQ + SQ : text.slice(i, end);
  return closed ? { end, keep } : { end, keep, unterminated: true };
}

/** Identifier characters as Postgres reads them: ASCII letters and underscore, digits after the first, and any character above 0x7f. */
function isTagChar(ch: string | undefined, first: boolean): boolean {
  if (ch === undefined) return false;
  const letter = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  return letter || ch.charCodeAt(0) > 0x7f || (!first && ch >= "0" && ch <= "9");
}

/** The opening tag at i, such as the two dollar signs or a named tag, or null when none starts here. */
function dollarTagAt(text: string, i: number): string | null {
  let at = i + 1;
  while (isTagChar(text[at], at === i + 1)) at++;
  return text[at] === "$" ? text.slice(i, at + 1) : null;
}

function skipDollarQuote(text: string, i: number): Skip | null {
  if (text[i] !== "$" || isIdentChar(text[i - 1])) return null;
  const tag = dollarTagAt(text, i);
  if (!tag) return null;
  const close = text.indexOf(tag, i + tag.length);
  if (close === -1) return { end: text.length, keep: " ", unterminated: true };
  return { end: close + tag.length, keep: " " };
}

function skipSpecial(text: string, i: number): Skip | null {
  return (
    skipLineComment(text, i) ??
    skipBlockComment(text, i) ??
    skipQuoted(text, i, SQ) ??
    skipQuoted(text, i, DQ) ??
    skipDollarQuote(text, i)
  );
}

/**
 * Split SQL into statements in one pass. Comments, string contents and dollar-quoted bodies are
 * recognised only where they can start, so a dollar sign or comment opener inside another
 * construct cannot hide the statements that follow it.
 */
export function splitStatements(text: string): { statements: string[]; unterminated: boolean } {
  const statements: string[] = [];
  let current = "";
  let unterminated = false;
  let i = 0;
  while (i < text.length) {
    const skip = skipSpecial(text, i);
    if (skip) {
      current += skip.keep;
      i = skip.end;
      unterminated ||= skip.unterminated === true;
    } else if (text[i] === ";") {
      statements.push(current);
      current = "";
      i++;
    } else {
      current += text[i++];
    }
  }
  statements.push(current);
  return { statements, unterminated };
}

export function normTable(raw: string): string {
  return raw
    .replace(/\x22/g, "")
    .trim()
    .toLowerCase()
    .replace(/^public\./, "");
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const CONSTRAINT_START = /^(constraint|primary|foreign|unique|check|like|exclude)\b/i;

/** The identifier a column definition starts with, with an optional double quote in front, or "". */
function leadingIdentifier(part: string): string {
  const start = part[0] === DQ ? 1 : 0;
  let end = start;
  while (isTagChar(part[end], end === start)) end++;
  return part.slice(start, end);
}

export function columnsOf(body: string): string[] {
  const names: string[] = [];
  for (const item of splitTopLevel(body)) {
    const part = item.trim();
    if (!part || CONSTRAINT_START.test(part)) continue;
    const name = leadingIdentifier(part);
    if (name) names.push(name.toLowerCase());
  }
  return names;
}
