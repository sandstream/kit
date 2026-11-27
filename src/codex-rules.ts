/**
 * Codex command rules, read as text.
 *
 * Codex keeps its command allowlist in `.rules` files (`~/.codex/rules/*.rules` and
 * `<repo>/.codex/rules/*.rules`), written in Starlark. Its documentation defines one function,
 * `prefix_rule(pattern=[…], decision="allow"|"prompt"|"forbidden", justification=…, match=[…],
 * not_match=[…])`, with `decision` defaulting to `"allow"`. The TUI appends to
 * `~/.codex/rules/default.rules` on every "don't ask again".
 *
 * kit never evaluates the file. It reads each top-level statement as a literal `prefix_rule(...)`
 * call whose arguments are string literals and lists of them. Anything else (a variable, a
 * `load()`, string concatenation, a positional argument, an unknown keyword, a triple-quoted
 * string) is returned as unparsed, never dropped, so a rule kit cannot read is never counted as a
 * narrow one. Pure.
 */

export type CodexDecision = "allow" | "prompt" | "forbidden";

export interface CodexRule {
  /** Each position: one literal, or the alternatives Codex accepts there. */
  pattern: string[][];
  decision: CodexDecision;
}

export type CodexStatement = { ok: true; rule: CodexRule } | { ok: false; text: string };

type Value = string | Value[];

const DECISIONS = new Set<string>(["allow", "prompt", "forbidden"]);
const KEYWORDS = new Set(["pattern", "decision", "justification", "match", "not_match"]);

/** Index of the end of a string literal that opens at `i` (the closing quote, or a newline). */
function stringEnd(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
  return Math.min(j, text.length - 1);
}

/** Top-level statements, with comments removed. Strings and brackets are tracked. */
function statements(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  const flush = (): void => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
    depth = 0;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = stringEnd(text, i);
      cur += text.slice(i, end + 1);
      i = end;
    } else if (ch === "#") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if ((ch === "\n" || ch === ";") && depth <= 0) flush();
    else {
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      cur += ch;
    }
  }
  flush();
  return out;
}

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  eat(ch: string): boolean {
    this.ws();
    if (this.s[this.i] !== ch) return false;
    this.i++;
    return true;
  }
  ident(): string | null {
    this.ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }
  string(): string | null {
    this.ws();
    const q = this.s[this.i];
    if (q !== '"' && q !== "'") return null;
    if (this.s.startsWith(q.repeat(3), this.i)) return null;
    let out = "";
    for (let j = this.i + 1; j < this.s.length; j++) {
      const ch = this.s[j];
      if (ch === "\n") return null;
      if (ch === q) {
        this.i = j + 1;
        return out;
      }
      if (ch === "\\") {
        const next = this.s[++j];
        if (next === undefined || !"\\'\"".includes(next)) return null;
        out += next;
      } else out += ch;
    }
    return null;
  }
  value(): Value | null {
    const str = this.string();
    if (str !== null) return str;
    if (!this.eat("[")) return null;
    const items: Value[] = [];
    while (!this.eat("]")) {
      const v = this.value();
      if (v === null) return null;
      items.push(v);
      if (!this.eat(",")) return this.eat("]") ? items : null;
    }
    return items;
  }
}

function patternOf(v: Value | undefined): string[][] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: string[][] = [];
  for (const el of v) {
    if (typeof el === "string") out.push([el]);
    else if (el.length > 0 && el.every((x): x is string => typeof x === "string")) out.push(el);
    else return null;
  }
  return out;
}

function args(statement: string): Map<string, Value> | null {
  const r = new Reader(statement);
  if (r.ident() !== "prefix_rule" || !r.eat("(")) return null;
  const out = new Map<string, Value>();
  while (!r.eat(")")) {
    const key = r.ident();
    if (key === null || !KEYWORDS.has(key) || out.has(key) || !r.eat("=")) return null;
    const v = r.value();
    if (v === null) return null;
    out.set(key, v);
    if (!r.eat(",")) {
      if (!r.eat(")")) return null;
      break;
    }
  }
  r.ws();
  return r.i === statement.length ? out : null;
}

function ruleOf(statement: string): CodexRule | null {
  const a = args(statement);
  if (a === null) return null;
  const pattern = patternOf(a.get("pattern"));
  const decision = a.get("decision") ?? "allow";
  if (pattern === null || typeof decision !== "string" || !DECISIONS.has(decision)) return null;
  const justification = a.get("justification");
  if (justification !== undefined && typeof justification !== "string") return null;
  return { pattern, decision: decision as CodexDecision };
}

/** Every top-level statement in a `.rules` file, parsed or returned as unparsed text. */
export function parseCodexRules(text: string): CodexStatement[] {
  return statements(text).map((s) => {
    const rule = ruleOf(s);
    return rule ? { ok: true, rule } : { ok: false, text: s };
  });
}

/** How a rule's pattern is shown: `git push`, `gh [pr|issue] view`. */
export function showPattern(pattern: string[][]): string {
  return pattern.map((alts) => (alts.length === 1 ? alts[0] : `[${alts.join("|")}]`)).join(" ");
}
