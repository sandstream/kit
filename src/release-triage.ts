/**
 * `kit triage release <url|file>`: check a prebuilt release archive or binary before it is
 * extracted, made executable, run or put on PATH. Five checks, each `pass`, `fail` or `unverified`,
 * as `kit triage pkg` reports them:
 *
 *   - checksum: SHA-256 against `--checksum`, else the publisher's checksum files next to the asset
 *     (and GitHub's own asset digest). Sources that disagree fail.
 *   - signature: minisign or cosign with a key the user names (release-signature.ts).
 *   - age: a GitHub release's publish date, through the same cooling period as packages.
 *   - repository: the GitHub repository against `--repo owner/repo`, and against the one GitHub
 *     actually serves the release from (a moved repository is named).
 *   - archive: every member of a tar, tar.gz or zip, for absolute paths, `..`, links out of the
 *     tree, setuid bits and special entries (release-archive.ts).
 *
 * It passes only with no `fail` and no `unverified` the user did not accept by name
 * (`--accept-unverified signature,age`). Nothing from the file is ever executed.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { inspectArchive } from "./release-archive.js";
import {
  checkSignatures,
  SIGNATURE_SUFFIXES,
  type SignatureKeys,
  type SignedFile,
} from "./release-signature.js";
import {
  checksumUrls,
  githubRelease,
  hashesFor,
  publishedChecksums,
  type ChecksumSource,
  type GithubRelease,
  type ReleaseFetch,
} from "./release-sources.js";
import { githubReleaseAsset, urlFileName, type GithubAsset } from "./release-url.js";

export type ReleaseStatus = "pass" | "fail" | "unverified";
export const RELEASE_CHECKS = ["checksum", "signature", "age", "repository", "archive"] as const;
export type ReleaseCheckName = (typeof RELEASE_CHECKS)[number];

export interface ReleaseCheck {
  name: ReleaseCheckName;
  status: ReleaseStatus;
  detail: string;
}

export interface ReleaseReport {
  url: string | null;
  file: string;
  sha256: string;
  checks: ReleaseCheck[];
  /** `unverified` checks the user accepted with --accept-unverified. */
  accepted: ReleaseCheckName[];
  passed: boolean;
}

export interface ReleaseOptions extends SignatureKeys {
  sha256?: string;
  shasumsText?: string;
  repo?: string;
  accept: ReleaseCheckName[];
}

/** The cooling verdict for a release date, from the project's `[supply_chain]` settings. */
export type ReleaseAge = (
  repo: string,
  tag: string,
  publishedAt: string,
) => Promise<{ status: ReleaseStatus; detail: string }>;

export interface ReleaseDeps extends ReleaseFetch {
  /** The GitHub API base, or null when it must not be queried (air-gap with no KIT_GITHUB_API). */
  githubApi: string | null;
  age: ReleaseAge;
}

const sha256File = async (path: string): Promise<string> => {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
};

function checksumCheck(actual: string, sources: ChecksumSource[]): ReleaseCheck {
  const name = "checksum";
  if (sources.length === 0) {
    return {
      name,
      status: "unverified",
      detail: "no checksum given (--checksum) or published next to the asset",
    };
  }
  const bad = sources.filter((s) => s.hashes.length !== 1 || s.hashes[0] !== actual);
  if (bad.length === 0) {
    return {
      name,
      status: "pass",
      detail: `${actual} matches ${sources.map((s) => s.source).join(", ")}`,
    };
  }
  const why = bad.map((s) =>
    s.hashes.length > 1
      ? `${s.source} names the asset with ${s.hashes.length} different hashes`
      : `${s.source} says ${s.hashes[0]}`,
  );
  return { name, status: "fail", detail: `the file is ${actual}; ${why.join("; ")}` };
}

async function checksumSources(
  url: string | null,
  asset: string,
  release: GithubRelease | null,
  opts: ReleaseOptions,
  deps: ReleaseDeps,
): Promise<ChecksumSource[]> {
  if (opts.sha256) return [{ source: "--checksum", hashes: [opts.sha256.toLowerCase()] }];
  if (opts.shasumsText !== undefined) {
    return [{ source: "--checksum", hashes: hashesFor(opts.shasumsText, asset) }];
  }
  const sources = url
    ? await publishedChecksums(checksumUrls(url, asset, release), asset, deps)
    : [];
  const digest = release?.assets.find((a) => a.name === asset)?.digest;
  if (digest) sources.push({ source: "the GitHub asset digest", hashes: [digest] });
  return sources;
}

/** Signature files next to `fileUrl`: the release's own when it lists its assets, else every suffix tried. */
async function signaturesNextTo(
  fileUrl: string,
  release: GithubRelease | null,
  deps: ReleaseDeps,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const name = urlFileName(fileUrl);
  for (const suffix of SIGNATURE_SUFFIXES) {
    const listed = release?.assets.find((a) => a.name === `${decodeSafe(name)}${suffix}`);
    if (release && !listed) continue;
    const text = await deps.fetchText(listed?.url ?? `${fileUrl}${suffix}`);
    if (text !== null) out[suffix] = text;
  }
  return out;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function signatureCheck(
  ctx: {
    url: string | null;
    file: string;
    asset: string;
    release: GithubRelease | null;
    lists: ChecksumSource[];
  },
  opts: ReleaseOptions,
  deps: ReleaseDeps,
): Promise<ReleaseCheck> {
  const files: SignedFile[] = [];
  if (ctx.url) {
    const signatures = await signaturesNextTo(ctx.url, ctx.release, deps);
    files.push({ label: ctx.asset, bytes: () => createReadStream(ctx.file), signatures });
    for (const list of ctx.lists.filter((l) => l.url && l.text !== undefined)) {
      const text = Buffer.from(list.text!);
      const listSigs = await signaturesNextTo(list.url!, ctx.release, deps);
      files.push({
        label: urlFileName(list.url!),
        bytes: () => Readable.from([text]),
        signatures: listSigs,
      });
    }
  }
  const result = await checkSignatures(files, opts);
  return { name: "signature", ...result };
}

function repositoryCheck(
  gh: GithubAsset | null,
  release: GithubRelease | null,
  expected?: string,
): ReleaseCheck {
  const name = "repository";
  if (!gh)
    return {
      name,
      status: "unverified",
      detail: "not a GitHub release URL, so no repository to compare",
    };
  const named = `${gh.owner}/${gh.repo}`;
  if (release?.servedFrom && release.servedFrom.toLowerCase() !== named.toLowerCase()) {
    return {
      name,
      status: "fail",
      detail: `the URL names ${named}, but GitHub serves the release from ${release.servedFrom} (moved or renamed)`,
    };
  }
  if (!expected)
    return {
      name,
      status: "unverified",
      detail: `${named}; no expected repository was named (use --repo owner/repo)`,
    };
  const ok = expected.toLowerCase() === named.toLowerCase();
  return {
    name,
    status: ok ? "pass" : "fail",
    detail: ok ? `${named} is the expected repository` : `${named} is not the expected ${expected}`,
  };
}

async function ageCheck(
  gh: GithubAsset | null,
  release: GithubRelease | null,
  deps: ReleaseDeps,
): Promise<ReleaseCheck> {
  const name = "age";
  if (!gh)
    return {
      name,
      status: "unverified",
      detail: "not a GitHub release URL, so no publish date is known",
    };
  if (!gh.tag) {
    return {
      name,
      status: "fail",
      detail:
        "a releases/latest/download URL changes with every release; triage the URL of the tag",
    };
  }
  if (!deps.githubApi)
    return {
      name,
      status: "unverified",
      detail: "air-gap is on and no KIT_GITHUB_API mirror is named",
    };
  if (!release?.publishedAt)
    return {
      name,
      status: "unverified",
      detail: `the GitHub API gave no release for tag ${gh.tag}`,
    };
  if (release.draft) return { name, status: "fail", detail: `${gh.tag} is a draft release` };
  const result = await deps.age(`${gh.owner}/${gh.repo}`, gh.tag, release.publishedAt);
  const pre = release.prerelease ? " (a prerelease)" : "";
  return { name, status: result.status, detail: `${result.detail}${pre}` };
}

/** Run every check on the local `file`, which is the asset at `url` when one is given. */
export async function triageRelease(
  target: { url: string | null; file: string },
  opts: ReleaseOptions,
  deps: ReleaseDeps,
): Promise<ReleaseReport> {
  const { url, file } = target;
  const gh = url ? githubReleaseAsset(url) : null;
  const asset = gh?.asset ?? (url ? decodeSafe(urlFileName(url)) : basename(file));
  const release = gh && deps.githubApi ? await githubRelease(gh, deps.githubApi, deps) : null;
  const sha256 = await sha256File(file);
  const lists = await checksumSources(url, asset, release, opts, deps);
  const archive = await inspectArchive(file);
  const checks: ReleaseCheck[] = [
    checksumCheck(sha256, lists),
    await signatureCheck({ url, file, asset, release, lists }, opts, deps),
    await ageCheck(gh, release, deps),
    repositoryCheck(gh, release, opts.repo),
    { name: "archive", status: archive.status, detail: archive.detail },
  ];
  if ((await sha256File(file)) !== sha256) {
    for (const c of checks)
      Object.assign(c, { status: "fail", detail: "the file changed while it was checked" });
  }
  const accepted = checks
    .filter((c) => c.status === "unverified" && opts.accept.includes(c.name))
    .map((c) => c.name);
  const passed = checks.every((c) => c.status === "pass" || accepted.includes(c.name));
  return { url, file, sha256, checks, accepted, passed };
}
