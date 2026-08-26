/**
 * Repo-map — ownership (Pillar 4, deterministic / zero-LLM).
 *
 * Answers "who owns this file?" for the repo-map slice, so an agent working a growing repo knows who
 * to route to. Primary source is a committed **CODEOWNERS** file (pure, deterministic — no I/O here);
 * a git-blame fallback lives in the command layer for repos without one. Matching follows GitHub's
 * CODEOWNERS rules closely enough for the common patterns: gitignore-style globs, last match wins.
 */

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

/**
 * Parse a CODEOWNERS file into ordered rules. Blank lines and `#` comments are skipped; each rule is
 * `PATTERN owner1 owner2…`. Order is preserved (GitHub semantics: the LAST matching rule wins). Pure.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1).filter(Boolean);
    if (pattern) rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Match a gitignore-style glob against a string. `?` = one non-`/` char, `*` = a run of non-`/`
 * chars, `**` = anything (including `/`). Recursive; patterns are short so backtracking is cheap.
 */
function globMatch(pat: string, str: string): boolean {
  if (pat === "") return str === "";
  if (pat.startsWith("**/")) {
    // `**/` = zero or more whole directory segments (the slash collapses when there are none).
    const rest = pat.slice(3);
    if (globMatch(rest, str)) return true; // zero dirs
    for (let k = 0; k < str.length; k++) {
      if (str[k] === "/" && globMatch(pat, str.slice(k + 1))) return true; // consume one dir, retry
    }
    return false;
  }
  if (pat.startsWith("**")) {
    const rest = pat.slice(2);
    for (let k = 0; k <= str.length; k++) {
      if (globMatch(rest, str.slice(k))) return true;
    }
    return false;
  }
  const ch = pat[0];
  if (ch === "*") {
    const rest = pat.slice(1);
    for (let k = 0; k <= str.length; k++) {
      if (k > 0 && str[k - 1] === "/") break; // `*` never crosses a slash
      if (globMatch(rest, str.slice(k))) return true;
    }
    return false;
  }
  if (str === "") return false;
  if (ch === "?") return str[0] !== "/" && globMatch(pat.slice(1), str.slice(1));
  return str[0] === ch && globMatch(pat.slice(1), str.slice(1));
}

/** Does a single CODEOWNERS pattern match a repo-relative path? */
function patternMatches(pattern: string, path: string): boolean {
  const leadingSlash = pattern.startsWith("/");
  const dirOnly = pattern.endsWith("/");
  const body = pattern.slice(leadingSlash ? 1 : 0, dirOnly ? -1 : undefined);
  if (!body) return false;

  // gitignore semantics: a slash in the body (or a leading slash) anchors to the repo root; a
  // slash-free pattern (e.g. `*.ts`, `docs`) matches at any depth (so also try it under any dir).
  const anchored = leadingSlash || body.includes("/");
  const bases = anchored ? [body] : [body, "**/" + body];
  for (const base of bases) {
    // A pattern matches the path itself, or (as a directory prefix) anything under it — the trailing
    // slash only signals intent; GitHub treats `docs` and `docs/` the same for a file underneath.
    if (globMatch(base, path) || globMatch(base + "/**", path)) return true;
  }
  return false;
}

/** Owners for a repo-relative path — the LAST matching rule's owners, or [] if none match. Pure. */
export function ownerFor(path: string, rules: CodeownersRule[]): string[] {
  let owners: string[] = [];
  for (const rule of rules) {
    if (patternMatches(rule.pattern, path)) owners = rule.owners;
  }
  return owners;
}

/** The standard locations a CODEOWNERS file may live, in GitHub's precedence order. */
export const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

/**
 * The most frequent author from a file's `git log --format=%an` lines — the de-facto owner when no
 * CODEOWNERS exists. Ties break alphabetically for determinism; blank lines are ignored; null if the
 * file has no history. Pure (the caller does the git I/O and feeds the lines here).
 */
export function topAuthor(authorLines: string[]): string | null {
  const counts = new Map<string, number>();
  for (const raw of authorLines) {
    const name = raw.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestN = -1;
  for (const [name, n] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best;
}
