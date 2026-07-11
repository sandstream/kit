/**
 * Repo-map — Python import extractor (deterministic, dependency-free, zero-LLM).
 *
 * Parses `import` / `from … import …` statements and resolves the in-repo ones to repo-relative file
 * ids, so `kit map` covers Python alongside TS/JS. Relative (dotted) imports resolve precisely against
 * the importer's package; absolute imports resolve from the repo root or a unique path suffix (src/
 * layouts). Anything that doesn't resolve to a known file is reported external — never guessed.
 */

/**
 * Extract module tokens from Python source: `import a.b`, `import a as x, c`, `from a.b import c`,
 * `from . import x`, `from .mod import y`, `from ..pkg import z`. Relative tokens keep their leading
 * dots. Deterministic, order-preserving, deduped. Pure.
 */
export function parsePythonImports(source: string): string[] {
  const tokens: string[] = [];
  const push = (t: string) => {
    const v = t.trim();
    if (v && !tokens.includes(v)) tokens.push(v);
  };
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const fromM = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(line);
    if (fromM) {
      const mod = fromM[1];
      if (/^\.+$/.test(mod)) {
        // `from . import a, b` / `from .. import x` — each name is a submodule of the (relative) pkg.
        for (const name of splitImportNames(fromM[2])) push(mod + name);
      } else {
        push(mod);
      }
      continue;
    }

    const importM = /^import\s+(.+)$/.exec(line);
    if (importM) {
      for (const part of importM[1].split(",")) {
        const mod = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (mod) push(mod);
      }
    }
  }
  return tokens;
}

/** Split the names after `import` (handles `(a, b)`, `as` aliases, trailing commas). */
function splitImportNames(rest: string): string[] {
  return rest
    .replace(/[()]/g, "")
    .split(",")
    .map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)[0]
        .trim(),
    )
    .filter(Boolean);
}

/** dirname on a posix repo-relative path ("" for a top-level file). */
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function upDirs(dir: string, n: number): string | null {
  let d = dir;
  for (let i = 0; i < n; i++) {
    if (d === "") return null; // walked above the repo root — unresolvable
    d = dirOf(d);
  }
  return d;
}

/** Candidate repo files for a slash path with no extension: `p.py` and `p/__init__.py`. */
function candidatesFor(base: string): string[] {
  const b = base.replace(/\/+$/, "");
  return b ? [b + ".py", b + "/__init__.py"] : [];
}

/**
 * Resolve a Python module `token` imported from repo-relative `fromRel` to a member of `fileSet`, or
 * null (external / unresolved — never guessed). Relative tokens (leading dots) resolve against the
 * importer's package; absolute tokens resolve from the repo root, then by a UNIQUE path-suffix match
 * (src/ layouts). An ambiguous absolute match (multiple candidates) stays external. Pure.
 */
export function resolvePythonImport(
  fromRel: string,
  token: string,
  fileSet: Set<string>,
): string | null {
  const dotMatch = /^(\.+)(.*)$/.exec(token);
  if (dotMatch) {
    const level = dotMatch[1].length;
    const rest = dotMatch[2].replace(/^\./, ""); // remainder after the leading dots
    const base = upDirs(dirOf(fromRel), level - 1); // 1 dot = current package (importer's dir)
    if (base === null) return null;
    const relPath = rest ? `${base}/${rest.split(".").join("/")}` : `${base}/__init__`;
    for (const c of candidatesFor(relPath)) if (fileSet.has(c)) return c;
    return null;
  }

  const segs = token.split(".").filter(Boolean);
  if (segs.length === 0) return null;
  const path = segs.join("/");
  // 1) exact from repo root
  for (const c of candidatesFor(path)) if (fileSet.has(c)) return c;
  // 2) unique suffix match (e.g. src/pkg/mod.py for `import pkg.mod`)
  const suffixes = candidatesFor(path).map((c) => "/" + c);
  const hits = [...fileSet].filter((f) => suffixes.some((s) => f.endsWith(s)));
  return hits.length === 1 ? hits[0] : null; // ambiguous → external (never guessed)
}
