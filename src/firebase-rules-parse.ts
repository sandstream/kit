/**
 * A text reader for Firebase security rules (`firestore.rules`, `storage.rules`).
 *
 * It is not the rules compiler. It blanks comments, follows nested `match` blocks by brace depth,
 * skips `function` bodies, and returns each `allow` statement with its methods, its condition as
 * written and the match path it sits under. A statement may span lines; it ends at `;`, at the
 * block's closing `}`, or where the next `allow`, `match` or `function` begins.
 *
 * Limits, on purpose: a condition is compared as text, so `if isPublic()` is not resolved even
 * when the function returns `true`, and `if true || x` is not reduced. Files the reader cannot
 * finish (an unterminated block comment, unbalanced braces) are reported as incomplete.
 */

export interface AllowRule {
  /** 1-based line of the `allow` keyword. */
  line: number;
  /** Methods as written: read, write, get, list, create, update, delete. */
  methods: string[];
  /** The condition with `if` removed and whitespace collapsed; null when the statement has none. */
  condition: string | null;
  /** The enclosing match paths joined, e.g. `/databases/{database}/documents/{document=**}`. */
  path: string;
}

export interface ParsedRules {
  allows: AllowRule[];
  /** Why the reader could not finish the file, or null. */
  incomplete: string | null;
}

/** End offset (exclusive) of the quoted string that starts at `start`; a newline ends it too. */
function stringEnd(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === quote) return i + 1;
    else if (src[i] === "\n") return i;
    else i++;
  }
  return src.length;
}

const blank = (s: string): string => s.replace(/[^\n]/g, " ");

/** Replace `//` and `/* *\/` comments with spaces, keeping newlines so line numbers hold. */
export function blankComments(src: string): { text: string; unterminated: boolean } {
  let out = "";
  let unterminated = false;
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    let end = i + 1;
    if (src[i] === "'" || src[i] === '"') end = stringEnd(src, i);
    else if (two === "//") end = src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i);
    else if (two === "/*") {
      const close = src.indexOf("*/", i + 2);
      unterminated ||= close === -1;
      end = close === -1 ? src.length : close + 2;
    }
    const piece = src.slice(i, end);
    out += two === "//" || two === "/*" ? blank(piece) : piece;
    i = end;
  }
  return { text: out, unterminated };
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const NEXT_STATEMENT = /(?<![\w.])(allow|match|function)\b/y;

/** Read a condition from `start` to its end; returns the raw text and the offset after it. */
function readCondition(text: string, start: number): { raw: string; end: number } {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (depth === 0 && (ch === ";" || ch === "}")) break;
    NEXT_STATEMENT.lastIndex = i;
    if (depth === 0 && NEXT_STATEMENT.test(text)) break;
    if (OPENERS.has(ch)) depth++;
    else if (CLOSERS.has(ch)) depth--;
    i++;
  }
  const end = text[i] === ";" ? i + 1 : i;
  return { raw: text.slice(start, i), end };
}

function normalizeCondition(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^if\b\s*/, "");
}

interface Frame {
  /** The match path, or "" for a non-match block such as `service cloud.firestore { … }`. */
  path: string;
}

interface Scan {
  text: string;
  stack: Frame[];
  allows: AllowRule[];
  lineStarts: number[];
  unbalanced: boolean;
}

function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** A match path is segments of plain text or `{name}` / `{name=**}` captures, then the block. */
const MATCH = /match\s+((?:[^\s{}]|\{[^\s{}]*\})+)\s*\{/y;
const FUNCTION = /function\s+\w+\s*\([^)]*\)\s*\{/y;
const ALLOW = /allow\s+([A-Za-z][A-Za-z\s,]*?)\s*(:|;|})/y;

function stickyAt(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

/** Offset just after the `}` that closes the block whose body starts at `start`. */
function skipBlock(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return i;
}

function readAllow(scan: Scan, i: number, m: RegExpExecArray): number {
  const methods = m[1].split(/[\s,]+/).filter(Boolean);
  const path = scan.stack.map((f) => f.path).join("");
  const line = lineAt(scan.lineStarts, i);
  if (m[2] !== ":") {
    scan.allows.push({ line, methods, condition: null, path });
    // A `}` ends the statement but still closes its block; leave it for the main loop.
    return m[2] === "}" ? ALLOW.lastIndex - 1 : ALLOW.lastIndex;
  }
  const { raw, end } = readCondition(scan.text, ALLOW.lastIndex);
  const condition = normalizeCondition(raw);
  scan.allows.push({ line, methods, condition: condition === "" ? null : condition, path });
  return end;
}

/** Advance the scan by one token from offset `i`; returns the next offset. */
function step(scan: Scan, i: number): number {
  const { text } = scan;
  const ch = text[i];
  if (ch === "'" || ch === '"') return stringEnd(text, i);
  if (ch === "{") {
    scan.stack.push({ path: "" });
    return i + 1;
  }
  if (ch === "}") {
    if (scan.stack.pop() === undefined) scan.unbalanced = true;
    return i + 1;
  }
  if (i > 0 && /[\w.]/.test(text[i - 1])) return i + 1;
  const match = stickyAt(MATCH, text, i);
  if (match) {
    scan.stack.push({ path: match[1] });
    return MATCH.lastIndex;
  }
  if (stickyAt(FUNCTION, text, i)) return skipBlock(text, FUNCTION.lastIndex);
  const allow = stickyAt(ALLOW, text, i);
  if (allow) return readAllow(scan, i, allow);
  return i + 1;
}

export function parseRules(src: string): ParsedRules {
  const { text, unterminated } = blankComments(src);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const scan: Scan = { text, stack: [], allows: [], lineStarts, unbalanced: false };
  let i = 0;
  while (i < text.length) i = step(scan, i);
  let incomplete: string | null = null;
  if (unterminated) incomplete = "unterminated block comment";
  else if (scan.unbalanced || scan.stack.length > 0) incomplete = "unbalanced braces";
  return { allows: scan.allows, incomplete };
}

/** `true`, or no condition at all: the statement grants the methods to everyone. */
export function isOpenCondition(condition: string | null): boolean {
  if (condition === null) return true;
  return condition.replace(/[\s()]/g, "") === "true";
}

const SIGNED_IN = new Set([
  "request.auth!=null",
  "null!=request.auth",
  "request.auth.uid!=null",
  "null!=request.auth.uid",
]);

/** The condition only asks that the caller is signed in. */
export function isSignedInOnly(condition: string | null): boolean {
  if (condition === null) return false;
  return SIGNED_IN.has(condition.replace(/[\s()]/g, ""));
}

/** Path segments below the service root (`/databases/{db}/documents`, `/b/{bucket}/o`). */
export function documentSegments(path: string): string[] {
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "databases" && segs[2] === "documents") return segs.slice(3);
  if (segs[0] === "b" && segs[2] === "o") return segs.slice(3);
  return segs;
}

/** The match's first segment below the root is a wildcard, so it covers every collection or path. */
export function isWildcardMatch(path: string): boolean {
  const first = documentSegments(path)[0];
  return first !== undefined && /^\{[^}]*\}$/.test(first);
}
