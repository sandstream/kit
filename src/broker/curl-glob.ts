/**
 * kit exec-broker — curl's URL globbing, expanded into the URLs it names.
 *
 * curl reads `[1-5]`, `[a-z]`, `[001-100:10]` and `{x,y}` in a URL as a pattern and requests every
 * URL it names, so `curl 10.0.0.[1-5]` and `curl http://h[1-3].example` contact five and three
 * hosts. The egress gate read no target in either and passed them with no verified scope. A
 * bounded pattern (at most 64 URLs) is expanded here so every host is checked; a larger or
 * malformed one is unreadable, and the gate denies it. A `[` that opens an IPv6 address
 * (`[::1]`) and a `\`-escaped bracket or brace are literal, as in curl. `-g`/`--globoff` turns
 * globbing off; the caller reads the word as it is then. Pure and deterministic.
 */

/** The most URLs a pattern may name before it is unreadable. */
export const CURL_GLOB_MAX = 64;

/** Whether `[text]` is an IPv6 address, which curl leaves unglobbed. */
function isIpv6(text: string): boolean {
  if (!text.includes(":")) return false;
  try {
    new URL(`http://[${text}]/`);
    return true;
  } catch {
    return false;
  }
}

/** The values of a `{x,y}` set, or null when it is malformed (nested or unescaped `[`). */
function setValues(body: string): string[] | null {
  if (/(?<!\\)[[{]/.test(body)) return null;
  return body.split(/(?<!\\),/).map((v) => v.replace(/\\(.)/g, "$1"));
}

/** The values of a `[a-z]` / `[01-10:2]` range, or null when it is malformed or too long. */
function rangeValues(body: string): string[] | null {
  const m = /^(?:([a-z])-([a-z])|([A-Z])-([A-Z])|(\d{1,9})-(\d{1,9}))(?::(\d{1,9}))?$/.exec(body);
  if (!m) return null;
  const step = m[7] === undefined ? 1 : Number(m[7]);
  const first = m[1] ?? m[3];
  const lo = first ? first.charCodeAt(0) : Number(m[5]);
  const hi = first ? (m[2] ?? m[4])!.charCodeAt(0) : Number(m[6]);
  if (step < 1 || lo > hi || Math.floor((hi - lo) / step) >= CURL_GLOB_MAX) return null;
  const pad = !first && m[5]!.startsWith("0") ? m[5]!.length : 0;
  const out: string[] = [];
  for (let n = lo; n <= hi; n += step) {
    out.push(first ? String.fromCharCode(n) : String(n).padStart(pad, "0"));
  }
  return out;
}

type Piece = { values: string[]; end: number };

/** The literal text from `i` (a run of plain text, or one escaped bracket or brace), if any. */
function literal(word: string, i: number): Piece | undefined {
  const c = word[i]!;
  if (c === "\\" && /[[\]{}]/.test(word[i + 1] ?? ""))
    return { values: [word[i + 1]!], end: i + 2 };
  if (/[[\]{}]/.test(c)) return undefined;
  const run = /^[^\\[\]{}]*/.exec(word.slice(i + 1))![0];
  return { values: [c + run], end: i + 1 + run.length };
}

/** The next piece of the pattern from `i`: its values and where it ends, or null if malformed. */
function piece(word: string, i: number): Piece | null {
  const text = literal(word, i);
  if (text) return text;
  const c = word[i]!;
  if (c === "}" || c === "]") return null;
  const close = word.indexOf(c === "{" ? "}" : "]", i + 1);
  if (close < 0) return null;
  const body = word.slice(i + 1, close);
  if (c === "[" && isIpv6(body)) return { values: [word.slice(i, close + 1)], end: close + 1 };
  const values = c === "{" ? setValues(body) : rangeValues(body);
  return values ? { values, end: close + 1 } : null;
}

/**
 * Every URL a curl glob pattern names, in curl's order, or null when the pattern is malformed or
 * names more than {@link CURL_GLOB_MAX}. A word with no pattern comes back as itself.
 */
export function expandCurlGlob(word: string): string[] | null {
  let out = [""];
  for (let i = 0; i < word.length;) {
    const next = piece(word, i);
    if (!next || out.length * next.values.length > CURL_GLOB_MAX) return null;
    out = out.flatMap((prefix) => next.values.map((v) => prefix + v));
    i = next.end;
  }
  return out;
}
