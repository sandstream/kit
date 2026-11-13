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

/** Shell redirections such as 2>&1 and &>file do not separate commands. */
export function shellSegments(text: string): string[] {
  return splitUnquoted(text, (value, i) => {
    if (/^[;|\n]$/.test(value[i])) return true;
    return value[i] === "&" && value[i - 1] !== ">" && value[i + 1] !== ">";
  });
}
