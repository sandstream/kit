/**
 * Split a command line into argv tokens the way a POSIX shell would for the common
 * cases — WITHOUT evaluating anything. Whitespace separates words; single quotes are
 * literal; double quotes group with `\"`, `\\`, `\$`, `` \` `` escapes; a backslash
 * escapes the next char outside quotes. No expansion (no `$VAR`, globs, subshells,
 * operators) — callers run the resulting argv via `execFile` (no shell), so this is
 * tokenization only, not a shell.
 *
 * Why it exists: `command.split(/\s+/)` mis-splits any quoted argument
 * (`git commit -m "a b"` → 4 tokens, not 3), so a naive split silently runs the wrong
 * command. Throws on an unterminated quote so the caller can refuse rather than guess.
 */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let hasWord = false; // distinguishes an empty quoted arg ("") from "no arg yet"
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (hasWord) {
        out.push(cur);
        cur = "";
        hasWord = false;
      }
      i++;
      continue;
    }
    hasWord = true;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated single quote");
      cur += input.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && input[i] !== '"') {
        const ch = input[i];
        const next = input[i + 1];
        if (ch === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
          cur += next;
          i += 2;
        } else {
          cur += ch;
          i++;
        }
      }
      if (i >= n) throw new Error("unterminated double quote");
      i++; // consume closing "
      continue;
    }
    if (c === "\\") {
      if (i + 1 < n) {
        cur += input[i + 1];
        i += 2;
      } else {
        cur += "\\";
        i++;
      }
      continue;
    }
    cur += c;
    i++;
  }
  if (hasWord) out.push(cur);
  return out;
}
