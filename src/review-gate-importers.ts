/**
 * The wide lane for `kit review gate`: importer counts at one exact commit, read from the local
 * clone's git objects instead of the working tree.
 *
 * kit's reviewer App counts on a checkout of the default branch, so a pull request cannot shrink
 * the count (src/review-protected-paths-wide.ts). A person running `kit review gate` is usually on
 * some other branch, so this reads the default branch's head commit straight from git: the same
 * files, the same parser and resolver, and src/review-gate-importers.test.ts checks the result
 * against importerCounts() on the same tree. Read-only; never fetches.
 */
import { execFileSync } from "node:child_process";
import { parseImportSpecifiers, resolveImport } from "./repomap/extract-ts.js";

/** Runs git and returns stdout; throws on a non-zero exit. */
export type GitRun = (args: string[], input?: string) => Buffer;

const isTest = (rel: string) => /\.test(-support)?\.ts$/.test(rel);
const isSource = (rel: string) =>
  rel.startsWith("src/") && rel.endsWith(".ts") && !rel.endsWith(".d.ts");

/** How many non-test modules import each module, from path → source text. Pure. */
export function importerCountsFromSources(
  sources: ReadonlyMap<string, string>,
): Map<string, number> {
  const fileSet = new Set(sources.keys());
  const counts = new Map<string, number>();
  for (const [from, text] of sources) {
    if (isTest(from)) continue;
    const targets = new Set<string>();
    for (const spec of parseImportSpecifiers(text)) {
      const to = resolveImport(from, spec, fileSet);
      if (to && to !== from) targets.add(to);
    }
    for (const to of targets) counts.set(to, (counts.get(to) ?? 0) + 1);
  }
  return counts;
}

/** Parse `git cat-file --batch` output (`<oid> blob <size>\n<bytes>\n` per object). Pure. */
export function parseCatFileBatch(out: Buffer, paths: readonly string[]): Map<string, string> {
  const sources = new Map<string, string>();
  let at = 0;
  for (const path of paths) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) throw new Error(`git cat-file ended early at ${path}`);
    const header = out.subarray(at, eol).toString("utf8");
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!m) throw new Error(`git cat-file could not read ${path}: ${header}`);
    const size = Number(m[1]);
    sources.set(path, out.subarray(eol + 1, eol + 1 + size).toString("utf8"));
    at = eol + 1 + size + 1;
  }
  return sources;
}

function gitIn(root: string): GitRun {
  return (args, input) =>
    execFileSync("git", ["-C", root, ...args], {
      input,
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 512 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    });
}

/**
 * Importer counts of `src/**` TypeScript at commit `sha` in the clone at `root`. Throws when the
 * commit is not in the clone, so the caller can say what to fetch rather than count something else.
 */
export function importerCountsAtCommit(
  root: string,
  sha: string,
  git: GitRun = gitIn(root),
): Map<string, number> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("not a commit sha");
  const listed = git(["ls-tree", "-r", "-z", "--name-only", sha, "--", "src"])
    .toString("utf8")
    .split("\0")
    .filter(isSource);
  if (listed.length === 0) return new Map();
  const out = git(["cat-file", "--batch"], listed.map((p) => `${sha}:${p}\n`).join(""));
  return importerCountsFromSources(parseCatFileBatch(out, listed));
}
