/**
 * Comparison for `kit upstream`: how far behind an installed version is, which lines of the newer
 * release notes mention a keyword, and the plain verdict. Pure functions. The keyword match is a
 * text match and says so: it never claims to know that code must change.
 */
import { isNewer, isValidVersion } from "./update-check.js";
import type { ReleaseInfo } from "./upstream-sources.js";

export type Bump = "none" | "patch" | "minor" | "major" | "unknown";

export type NoteKeyword = "breaking" | "deprecat" | "migrat" | "removed";

export type Verdict =
  | "current"
  | "upgrade available"
  | "upgrade available, read notes"
  | "upgrade recommended (deprecation)"
  | "major, read notes"
  | "unknown"
  | "skipped";

export interface NoteHit {
  tag: string;
  url: string;
  line: string;
  keyword: NoteKeyword;
}

const KEYWORDS: readonly NoteKeyword[] = ["breaking", "deprecat", "migrat", "removed"];
const MAX_HITS_PER_RELEASE = 5;
const MAX_LINE_CHARS = 200;

function core(version: string): number[] {
  return version
    .replace(/^v/, "")
    .replace(/[-+].*$/, "")
    .split(".")
    .map(Number);
}

export function classifyBump(installed: string | null, latest: string | null): Bump {
  if (!installed || !latest || !isValidVersion(installed) || !isValidVersion(latest))
    return "unknown";
  if (!isNewer(latest, installed)) return "none";
  const [iMajor, iMinor] = core(installed);
  const [lMajor, lMinor] = core(latest);
  if (lMajor !== iMajor) return "major";
  return lMinor !== iMinor ? "minor" : "patch";
}

function keywordOf(line: string): NoteKeyword | undefined {
  const lower = line.toLowerCase();
  return KEYWORDS.find((k) => lower.includes(k));
}

/** Keyword lines from releases newer than `installed`. Prereleases and untagged releases are skipped. */
export function extractNoteHits(
  releases: readonly ReleaseInfo[],
  installed: string | null,
): NoteHit[] {
  const hits: NoteHit[] = [];
  for (const release of releases) {
    if (release.prerelease || !release.version) continue;
    if (installed && !isNewer(release.version, installed)) continue;
    let taken = 0;
    for (const raw of release.body.split(/\r?\n/)) {
      if (taken >= MAX_HITS_PER_RELEASE) break;
      const keyword = keywordOf(raw);
      if (!keyword) continue;
      hits.push({
        tag: release.tag,
        url: release.url,
        line: raw.trim().slice(0, MAX_LINE_CHARS),
        keyword,
      });
      taken++;
    }
  }
  return hits;
}

export interface VerdictInput {
  lookup: "ok" | "unknown" | "skipped";
  bump: Bump;
  hits: readonly NoteHit[];
}

export function decideVerdict(input: VerdictInput): Verdict {
  if (input.lookup === "skipped") return "skipped";
  if (input.lookup === "unknown" || input.bump === "unknown") return "unknown";
  if (input.bump === "none") return "current";
  if (input.bump === "major") return "major, read notes";
  if (input.hits.some((h) => h.keyword === "deprecat")) return "upgrade recommended (deprecation)";
  return input.hits.length > 0 ? "upgrade available, read notes" : "upgrade available";
}
