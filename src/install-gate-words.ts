/** Split literal shell text without expansion or execution. Keep quoted and escaped delimiters. */
function splitUnquoted(text: string, boundary: (text: string, index: number) => boolean): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let wordStart = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const comment = quote || !wordStart ? -1 : commentEnd(text, i);
    if (comment >= 0) {
      i = comment;
      continue;
    }
    if (char === "\\" && quote !== "'" && i + 1 < text.length) {
      wordStart &&= text[i + 1] === "\n";
      i++;
      continue;
    }
    const nextQuote = quoteAfter(quote, char);
    if (nextQuote !== quote) {
      quote = nextQuote;
      wordStart = false;
      continue;
    }
    wordStart = !quote && /[\s;|&()<>]/.test(char);
    if (!quote && boundary(text, i)) {
      if (i > start) parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

/** Quotes and operators inside a shell comment have no syntax. Leave the newline for the caller. */
function commentEnd(text: string, i: number): number {
  if (text[i] !== "#") return -1;
  const end = text.indexOf("\n", i);
  return end < 0 ? text.length : end - 1;
}

function quoteAfter(quote: string, char: string): string {
  if (char === quote) return "";
  return !quote && (char === "'" || char === '"') ? char : quote;
}

/** Raw words retain quotes for redirection handling and preserve empty quoted arguments. */
export function shellWords(text: string): string[] {
  return splitUnquoted(text, (value, i) => /\s/.test(value[i])).filter(
    (word) => !/^(?:\\\n)+$/.test(word),
  );
}

/**
 * Remove shell redirects before matching package operands.
 * A bare redirect consumes its following target. Quoted operands stay in the token list.
 */
const REDIRECT_OP_RE = /^\d*(>>?|<{1,2})(&\d*)?$/; // > >> < << 2> 2>> >& 2>&1 1>&2
const REDIRECT_WITH_TARGET_RE = /^(\d*(>>?|<{1,2})|&>{1,2})(\/|\.|\w|~|-|"|')/; // >/dev/null 2>file &>log <input
export function stripRedirections(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "&>" || tok === "&>>" || REDIRECT_OP_RE.test(tok)) {
      // `2>&1` / `1>&2` name their target inside the token. Every other bare
      // operator (`>`, `2>`, `<`, `>&`, `&>`) takes the NEXT token as its file
      // target.
      const selfContained = /&\d+$/.test(tok);
      if (!selfContained) i++;
      continue;
    }
    if (REDIRECT_WITH_TARGET_RE.test(tok)) continue; // operator and target in one token
    out.push(tok);
  }
  return out;
}

/** Apply literal shell quote removal. Single quotes preserve every character inside them. */
export function shellWordValue(word: string): string {
  let value = "";
  let quote = "";
  for (let i = 0; i < word.length; i++) {
    const char = word[i];
    if (char === quote) {
      quote = "";
      continue;
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    const next = word[i + 1];
    if (removesEscape(char, next, quote)) {
      if (next !== "\n") value += next;
      i++;
    } else value += char;
  }
  return value;
}

function removesEscape(char: string, next: string | undefined, quote: string): boolean {
  if (char !== "\\" || next === undefined || quote === "'") return false;
  return !quote || '\\$"`\n'.includes(next);
}

/** A list separator: `;`, a newline, `&`, `&&` or `||`. A single `|` (and `|&`) is a pipe. */
function listBoundary(text: string, i: number): boolean {
  const char = text[i];
  if (char === ";" || char === "\n") return true;
  if (char === "|") return text[i - 1] === "|" || text[i + 1] === "|";
  return char === "&" && !/[>|]/.test(text[i - 1] ?? "") && text[i + 1] !== ">";
}

/** Each pipeline's stages, as text. `a | b && c` is `[["a ", " b "], [" c"]]`. */
export function shellPipelines(text: string): string[][] {
  return splitUnquoted(text, listBoundary).map((pipeline) =>
    splitUnquoted(pipeline, (value, i) => value[i] === "|").map((s) => s.replace(/^&/, "")),
  );
}

/** Shell redirections such as 2>&1 and &>file do not separate commands. */
export function shellSegments(text: string): string[] {
  return splitUnquoted(text, (value, i) => {
    if (/^[;|\n]$/.test(value[i])) return true;
    return value[i] === "&" && value[i - 1] !== ">" && value[i + 1] !== ">";
  });
}
