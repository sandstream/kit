/**
 * Does an installed runtime fall inside a range a repo declares?
 *
 * Answered at the granularity kit pins at: a Node major (depth 1), a Python minor (depth 2).
 * So `>=20.0.0` admits Node 22, and `>=3.10,<3.13` admits Python 3.11. A deliberate subset of
 * npm ranges and PEP 440 specifiers: a clause it cannot read answers no, and the caller then
 * falls back to what the repo literally says instead of guessing.
 */

type Version = number[];

/** `20`, `v20.1.0`, `3.10.*`, `20.x` → the numeric components before any wildcard. */
function parseVersion(text: string): Version | null {
  const parts: number[] = [];
  for (const p of text.replace(/^v/, "").split(".")) {
    if (p === "x" || p === "X" || p === "*") break;
    if (!/^\d+$/.test(p)) return null;
    parts.push(Number(p));
  }
  return parts;
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** One comparator against the installed version, both cut to `depth` components. */
function clauseAdmits(op: string, wanted: Version, have: Version, depth: number): boolean {
  const at = wanted.slice(0, depth);
  // `>20.1` still admits some 20.x, and `<20.1` admits 20.0: finer than the pin, so the
  // boundary itself counts.
  const finer = wanted.slice(depth).some((n) => n > 0);
  const c = compare(have.slice(0, depth), at);
  switch (op) {
    case ">=":
      return c >= 0;
    case ">":
      return finer ? c >= 0 : c > 0;
    case "<":
      return finer ? c <= 0 : c < 0;
    case "<=":
      return c <= 0;
    case "~=":
      return c >= 0 && have[0] === wanted[0];
    case "!=":
      return true;
    default:
      // `=`, `==`, `^`, `~` or bare: the same line, compared as far as the clause says.
      return compare(have.slice(0, at.length), at) === 0;
  }
}

const CLAUSE = /^(>=|<=|~=|==|!=|>|<|=|\^|~)?\s*(\S*)$/;

function clauseText(clause: string, have: Version, depth: number): boolean {
  const m = CLAUSE.exec(clause.trim());
  if (!m) return false;
  if (m[2] === "" || m[2] === "*" || m[2] === "x") return true;
  const wanted = parseVersion(m[2]);
  return wanted !== null && clauseAdmits(m[1] ?? "", wanted, have, depth);
}

/** An npm `engines` range (`>=20`, `^18 || >=20`, `18 - 22`) admits the installed major. */
export function npmRangeAdmits(range: string, installed: string): boolean {
  const have = parseVersion(installed.trim());
  if (!have || have.length === 0) return false;
  return range.split("||").some((alt) => {
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt);
    const text = hyphen ? `>=${hyphen[1]} <=${hyphen[2]}` : alt;
    const clauses = text
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
      .trim()
      .split(/\s+/);
    return clauses.every((c) => clauseText(c, have, 1));
  });
}

/** A PEP 440 `requires-python` (`>=3.10,<3.13`) admits the installed minor. */
export function pep440Admits(spec: string, installed: string): boolean {
  const have = parseVersion(installed.trim());
  if (!have || have.length < 2) return false;
  return spec.split(",").every((c) => clauseText(c, have, 2));
}

/** The major an npm range names alone (`20`, `v20`, `20.x`, `^20.1.0`, `~20.3`), else null. */
export function singleNpmMajor(range: string): string | null {
  return /^\s*[\^~=]?\s*v?(\d+)(\.[xX*\d]+)*\s*$/.exec(range)?.[1] ?? null;
}
