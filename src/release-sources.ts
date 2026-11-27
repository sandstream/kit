/**
 * Where `kit triage release` finds what a publisher says about an asset: the checksum lists and
 * signature files published next to it, and, for a GitHub release, the release record (its date,
 * its asset list and the repository GitHub serves it from). Every lookup returns null on any
 * failure; the caller turns that into `unverified`, never into `pass`.
 */
import { posix } from "node:path";
import type { GithubAsset } from "./release-url.js";

export interface ReleaseFetch {
  /** GET a text document (≤ 2 MB), or null on any failure. */
  fetchText: (url: string) => Promise<string | null>;
  /** GET a JSON document, or null on any failure. */
  getJson: (url: string) => Promise<unknown>;
}

export interface GithubRelease {
  tag: string;
  publishedAt: string | null;
  draft: boolean;
  prerelease: boolean;
  /** `owner/repo` as the API serves it (a renamed or transferred repository answers with its new name). */
  servedFrom: string | null;
  assets: { name: string; url: string; digest: string | null }[];
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** The repository named in a release's API `url` (`…/repos/<o>/<r>/releases/<id>`). */
function servedFrom(apiUrl: string | null): string | null {
  const m = apiUrl ? /\/repos\/([^/]+\/[^/]+)\/releases\//.exec(apiUrl) : null;
  return m ? m[1]! : null;
}

function assetList(raw: unknown): GithubRelease["assets"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a: unknown) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const name = asString(o.name);
    const url = asString(o.browser_download_url);
    if (!name || !url) return [];
    const digest = asString(o.digest);
    return [
      {
        name,
        url,
        digest: digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest.slice(7) : null,
      },
    ];
  });
}

/** The release record for a tag, read from the GitHub API at `apiBase`, or null. */
export async function githubRelease(
  gh: GithubAsset,
  apiBase: string,
  f: ReleaseFetch,
): Promise<GithubRelease | null> {
  if (!gh.tag) return null;
  const path = [gh.owner, gh.repo].map(encodeURIComponent).join("/");
  const raw = await f.getJson(
    `${apiBase}/repos/${path}/releases/tags/${encodeURIComponent(gh.tag)}`,
  );
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    tag: asString(o.tag_name) ?? gh.tag,
    publishedAt: asString(o.published_at),
    draft: o.draft === true,
    prerelease: o.prerelease === true,
    servedFrom: servedFrom(asString(o.url)),
    assets: assetList(o.assets),
  };
}

/** Checksum list names publishers use, matched case-insensitively. `<asset>.sha256` is tried as well. */
const LIST_NAMES =
  /^(?:sha256sums(?:\.txt)?|checksums?(?:\.txt)?|.*[._-]checksums?\.txt|.*[._-]sha256sums(?:\.txt)?)$/i;

/** URLs of the checksum files to read for `asset`: the release's own when it has an asset list, else guesses next to the URL. */
export function checksumUrls(
  assetUrl: string,
  asset: string,
  release: GithubRelease | null,
): string[] {
  if (release) {
    const own = new Set(
      [`${asset}.sha256`, `${asset}.sha256sum`, `${asset}.sha256.txt`].map((n) => n.toLowerCase()),
    );
    return release.assets
      .filter((a) => own.has(a.name.toLowerCase()) || LIST_NAMES.test(a.name))
      .map((a) => a.url);
  }
  const dir = assetUrl.slice(0, assetUrl.lastIndexOf("/") + 1);
  return [`${assetUrl}.sha256`, `${dir}SHA256SUMS`, `${dir}checksums.txt`];
}

const HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Every hash a checksum text gives for `asset`: GNU `<hex>  name`, BSD `SHA256 (name) = <hex>`, or,
 * only in the asset's own `<asset>.sha256` file (`lone`), a hash with no name.
 */
export function hashesFor(text: string, asset: string, lone = false): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lone && lines.length === 1 && HEX.test(lines[0]!)) return [lines[0]!.toLowerCase()];
  const out = new Set<string>();
  for (const line of lines) {
    const gnu = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    const bsd = /^SHA256 \((.+)\) = ([0-9a-fA-F]{64})$/.exec(line);
    const [hash, name] = gnu ? [gnu[1]!, gnu[2]!] : bsd ? [bsd[2]!, bsd[1]!] : [null, null];
    if (hash && name && sameAsset(name, asset)) out.add(hash.toLowerCase());
  }
  return [...out];
}

/** `name` from a list matches `asset` exactly, or as the last path component (`./dist/x` names `x`). */
function sameAsset(name: string, asset: string): boolean {
  return name === asset || posix.basename(name.replace(/\\/g, "/")) === asset;
}

export interface ChecksumSource {
  /** Where the hash came from: a URL, "--checksum", or "the GitHub asset digest". */
  source: string;
  hashes: string[];
  /** The text, when the source is a file a signature may cover. */
  text?: string;
  url?: string;
}

/** Read every candidate checksum file. Ones that cannot be read or do not name the asset are left out. */
export async function publishedChecksums(
  urls: string[],
  asset: string,
  f: ReleaseFetch,
): Promise<ChecksumSource[]> {
  const out: ChecksumSource[] = [];
  for (const url of urls) {
    const text = await f.fetchText(url);
    if (text === null) continue;
    const own = url.slice(url.lastIndexOf("/") + 1).toLowerCase();
    const lone = own.startsWith(`${encodeURIComponent(asset).toLowerCase()}.sha256`);
    const hashes = hashesFor(text, asset, lone);
    if (hashes.length) out.push({ source: url, hashes, text, url });
  }
  return out;
}
