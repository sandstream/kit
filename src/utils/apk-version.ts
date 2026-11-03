/**
 * Alpine (apk) version ordering, for comparing a Dockerfile's `apk add 'pkg>=X'` floor with the
 * version that fixes a CVE. A version is `digits(.digits)*[letter](_suffix[digits])*[-rN]`.
 * Pre-release suffixes (_alpha, _beta, _pre, _rc) sort before the plain version and
 * post-release ones (_cvs, _svn, _git, _hg, _p) after it, as in apk-tools. Pure.
 */

const SUFFIX_RANK: Readonly<Record<string, number>> = {
  alpha: -4,
  beta: -3,
  pre: -2,
  rc: -1,
  cvs: 1,
  svn: 2,
  git: 3,
  hg: 4,
  p: 5,
};

interface ApkVersion {
  numbers: number[];
  letter: string;
  suffixes: [number, number][];
  revision: number;
}

const VERSION = /^(\d+(?:\.\d+)*)([a-z]?)((?:_[a-z]+\d*)*)(?:-r(\d+))?$/;

/** The parts of an apk version, or null when the text is not one. */
export function parseApkVersion(text: string): ApkVersion | null {
  const m = VERSION.exec(text.trim());
  if (!m) return null;
  const suffixes: [number, number][] = [];
  for (const part of (m[3] ?? "").split("_").filter(Boolean)) {
    const s = /^([a-z]+)(\d*)$/.exec(part);
    const rank = s ? SUFFIX_RANK[s[1]] : undefined;
    if (!s || rank === undefined) return null;
    suffixes.push([rank, Number(s[2] || 0)]);
  }
  return {
    numbers: m[1].split(".").map(Number),
    letter: m[2] ?? "",
    suffixes,
    revision: Number(m[4] ?? 0),
  };
}

function compareParsed(a: ApkVersion, b: ApkVersion): number {
  const n = Math.max(a.numbers.length, b.numbers.length);
  for (let i = 0; i < n; i++) {
    const d = (a.numbers[i] ?? -1) - (b.numbers[i] ?? -1);
    if (d !== 0) return Math.sign(d);
  }
  if (a.letter !== b.letter) return a.letter < b.letter ? -1 : 1;
  const s = Math.max(a.suffixes.length, b.suffixes.length);
  for (let i = 0; i < s; i++) {
    const [ra, na] = a.suffixes[i] ?? [0, 0];
    const [rb, nb] = b.suffixes[i] ?? [0, 0];
    if (ra !== rb) return Math.sign(ra - rb);
    if (na !== nb) return Math.sign(na - nb);
  }
  return Math.sign(a.revision - b.revision);
}

/** -1, 0 or 1; null when either side is not an apk version. */
export function compareApkVersions(a: string, b: string): number | null {
  const pa = parseApkVersion(a);
  const pb = parseApkVersion(b);
  return pa && pb ? compareParsed(pa, pb) : null;
}
