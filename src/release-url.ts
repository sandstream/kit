/**
 * The identity of a release asset URL, shared by `kit triage release` (which writes a receipt for
 * it) and the install gate (which looks the receipt up). Both must spell a URL the same way, or a
 * receipt written for `HTTPS://H.example/a.tgz` would not match the command that fetches
 * `https://h.example/a.tgz`. Pure: no I/O.
 */

/** The receipt type `kit triage release` writes and the install gate reads. */
export const RELEASE_RECEIPT_TYPE = "release";

/** `url` in the one spelling receipts use (WHATWG serialisation, no fragment), or null if it is not http(s). */
export function canonicalReleaseUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  parsed.hash = "";
  return parsed.href;
}

/** A GitHub release asset URL, split into its parts. `tag` is null for a `latest/download` URL. */
export interface GithubAsset {
  owner: string;
  repo: string;
  tag: string | null;
  asset: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function githubPath(url: string): string[] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return null;
  const parts = parsed.pathname.split("/").slice(1).map(safeDecode);
  return parts.every((p): p is string => p !== null) ? parts : null;
}

/** The parts of `https://github.com/<o>/<r>/releases/download/<tag>/<asset>`, or null. */
export function githubReleaseAsset(url: string): GithubAsset | null {
  const parts = githubPath(url);
  if (!parts || parts.length !== 6 || parts[2] !== "releases") return null;
  const [owner, repo, , a, b, asset] = parts as [string, string, string, string, string, string];
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo) || !b || !asset) return null;
  if (a === "latest" && b === "download") return { owner, repo, tag: null, asset };
  if (a === "download") return { owner, repo, tag: b, asset };
  return null;
}

function safeDecode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** The last path segment of a URL, as curl `-O` and wget name the file (not decoded), or "". */
export function urlFileName(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.slice(path.lastIndexOf("/") + 1);
  } catch {
    return "";
  }
}
