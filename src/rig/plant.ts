/**
 * Plant a defect from history (rig phase 5): take a commit that fixed a real bug, reverse its
 * diff onto the manifest's pinned commit, and the reversed change is the planted defect. Real
 * past bugs are better seeds than invented ones ("incidents become evals"), and no model is
 * involved at any step.
 *
 * The reverse is applied to the pinned tree in a throwaway index (`GIT_INDEX_FILE`), never to
 * the working tree. A fix whose reverse does not apply cleanly is refused, never guessed. The
 * stored patch is re-diffed against the pinned commit, so its line numbers are the pinned
 * file's, and the defect's `line_start`/`line_end` come from that patch's hunks.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class PlantRefused extends Error {}

export interface PlantedDefect {
  file: string;
  line_start: number;
  line_end: number;
  patch: string;
}

const SHA = /^[0-9a-f]{7,64}$/;

/**
 * The file and the new-side line range of a single-file unified diff. Hunks with no added or
 * changed line on the new side (a pure deletion) still mark their position.
 */
export function plantedRange(patch: string): {
  file: string;
  line_start: number;
  line_end: number;
} {
  const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  if (files.length !== 1)
    throw new PlantRefused(
      `the reversed fix touches ${files.length} files; plant one file per defect`,
    );
  let start = Infinity;
  let end = 0;
  for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const first = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    start = Math.min(start, Math.max(first, 1));
    end = Math.max(end, Math.max(first, 1) + Math.max(count, 1) - 1);
  }
  if (!Number.isFinite(start)) throw new PlantRefused("the reversed fix has no hunks");
  return { file: files[0], line_start: start, line_end: end };
}

function git(
  repo: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  input?: string,
): string {
  return execFileSync("git", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: repo,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function commit(repo: string, ref: string, what: string): string {
  if (!SHA.test(ref)) throw new PlantRefused(`${what} must be a hex commit id`);
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    throw new PlantRefused(`${what} ${ref} is not a commit in ${repo}`);
  }
}

/**
 * Reverse `fix` (or only its change to `path`) onto `pinned` in a throwaway index and return the
 * planted patch and its range. A real fix usually touches a test and the changelog as well;
 * `path` plants just the code change.
 * Throws `PlantRefused` when the fix is not a commit, touches more than one file, is binary, or
 * its reverse does not apply cleanly to the pinned tree.
 */
export function plantFromFix(
  repo: string,
  pinned: string,
  fix: string,
  path?: string,
): PlantedDefect {
  const pinnedSha = commit(repo, pinned, "the pinned commit");
  const fixSha = commit(repo, fix, "--from-fix");
  const only = path ? ["--", path.replace(/\\/g, "/")] : [];
  const reversed = git(repo, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--binary",
    fixSha,
    `${fixSha}^`,
    ...only,
  ]);
  if (reversed.trim() === "") throw new PlantRefused(`${fix} changes nothing to reverse`);
  if (/^GIT binary patch$/m.test(reversed)) throw new PlantRefused(`${fix} changes a binary file`);
  const work = mkdtempSync(join(tmpdir(), "kit-rig-plant-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(work, "index") };
    const patchFile = join(work, "reversed.diff");
    writeFileSync(patchFile, reversed);
    git(repo, ["read-tree", pinnedSha], env);
    try {
      git(repo, ["apply", "--cached", "--check", patchFile], env);
    } catch {
      throw new PlantRefused(
        `the reverse of ${fix} does not apply cleanly to the pinned commit; not guessed`,
      );
    }
    git(repo, ["apply", "--cached", patchFile], env);
    const patch = git(repo, ["diff", "--cached", "--no-color", "--no-ext-diff", pinnedSha], env);
    return { ...plantedRange(patch), patch };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The `[[defect]]` block to append to rig.toml for a planted defect. */
export function defectToml(
  d: Omit<PlantedDefect, "patch">,
  opts: { id: string; split: "tune" | "holdout"; patchPath: string; kind?: string },
): string {
  const q = (s: string): string => JSON.stringify(s);
  return [
    "[[defect]]",
    `id = ${q(opts.id)}`,
    `file = ${q(d.file)}`,
    `line_start = ${d.line_start}`,
    `line_end = ${d.line_end}`,
    `kind = ${q(opts.kind ?? "reverted-fix")}`,
    `split = ${q(opts.split)}`,
    `patch = ${q(opts.patchPath)}`,
    "",
  ].join("\n");
}
