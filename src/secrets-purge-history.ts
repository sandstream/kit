/**
 * Destructive git-history secret scrubbing — opt-in only.
 *
 * When a credential lands in a committed file the next thing to do is
 * rotate it; the value in `git log` keeps leaking until the history is
 * rewritten. This module wraps `git filter-repo` (preferred) or `bfg-repo-
 * cleaner` (fallback) to remove the value from every commit in the repo.
 *
 * **Destructive**: rewrites every commit hash from the first affected commit
 * forward, force-pushing is required afterwards, and every existing clone
 * (including CI runners, teammates' laptops, deploy pipelines that fork
 * from the same remote) must re-clone — pulling won't catch up cleanly.
 *
 * For this reason the CLI surface always requires:
 *   1. A live elevation marker (from `kit auth elevate`)
 *   2. An explicit `--force-history` flag — no auto-run, no default
 *   3. Confirmation prompt with the full impact spelled out, unless
 *      `--yes` is set (CI escape hatch; still requires elevation)
 */

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./utils/exec.js";


export type Tool = "git-filter-repo" | "bfg";

export interface ToolStatus {
  filterRepoAvailable: boolean;
  bfgAvailable: boolean;
}

export async function detectTools(): Promise<ToolStatus> {
  let filterRepoAvailable = false;
  let bfgAvailable = false;
  try {
    await exec("git", ["filter-repo", "--version"], { timeout: 3_000 });
    filterRepoAvailable = true;
  } catch {
    /* not installed */
  }
  try {
    await exec("bfg", ["--version"], { timeout: 3_000 });
    bfgAvailable = true;
  } catch {
    /* not installed */
  }
  return { filterRepoAvailable, bfgAvailable };
}

export interface PurgePreview {
  pattern: string;
  matchedCommits: number;
  matchedFiles: string[];
  sampleHashes: string[];
}

/**
 * Reports how many commits in the current branch's history reference the
 * pattern. Useful for showing impact before the destructive step.
 */
export async function previewMatches(
  pattern: string,
  cwd: string = process.cwd(),
): Promise<PurgePreview> {
  const { stdout: hashesOut } = await exec(
    "git",
    ["log", "--pretty=%H", "-S", pattern, "--all"],
    { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));
  const hashes = hashesOut.split("\n").filter(Boolean);

  const fileSet = new Set<string>();
  if (hashes.length > 0) {
    // For the first up-to-10 matching commits, extract the changed files
    // that mentioned the pattern so the user knows what got touched.
    for (const h of hashes.slice(0, 10)) {
      try {
        const { stdout } = await exec(
          "git",
          ["log", "-1", "--name-only", "--pretty=", "-S", pattern, h],
          { cwd, timeout: 10_000 },
        );
        for (const f of stdout.split("\n").filter(Boolean)) fileSet.add(f);
      } catch {
        /* skip */
      }
    }
  }

  return {
    pattern,
    matchedCommits: hashes.length,
    matchedFiles: [...fileSet],
    sampleHashes: hashes.slice(0, 5),
  };
}

export interface PurgeResult {
  toolUsed: Tool;
  ok: boolean;
  detail: string;
}

/**
 * Runs `git filter-repo --replace-text <file>` where the replacement file
 * contains one regex per line in `pattern==>***REDACTED***` syntax. Falls
 * back to `bfg --replace-text` when filter-repo is missing. The replacement
 * file is created in a tempdir and removed after the run.
 *
 * Caller is responsible for:
 *   - confirming the destructive action with the user
 *   - holding a fresh elevation marker
 *   - communicating "force-push + re-clone for everyone" afterwards
 */
export async function purgeHistory(
  patterns: string[],
  cwd: string = process.cwd(),
): Promise<PurgeResult> {
  if (patterns.length === 0) {
    return {
      toolUsed: "git-filter-repo",
      ok: false,
      detail: "no patterns provided",
    };
  }

  const tools = await detectTools();
  const dir = await mkdtemp(join(tmpdir(), "kit-purge-"));
  try {
    const replacementFile = join(dir, "replacements.txt");
    // git filter-repo replace-text format: `literal==>REPLACEMENT` or
    // `regex:<pattern>==>REPLACEMENT`. We default to literal for safety.
    await writeFile(
      replacementFile,
      patterns.map((p) => `${p}==>***REMOVED***`).join("\n") + "\n",
      "utf-8",
    );

    if (tools.filterRepoAvailable) {
      try {
        const { stdout } = await exec(
          "git",
          ["filter-repo", "--replace-text", replacementFile, "--force"],
          { cwd, timeout: 600_000, maxBuffer: 50 * 1024 * 1024 },
        );
        return {
          toolUsed: "git-filter-repo",
          ok: true,
          detail: stdout.split("\n").slice(-3).join(" ").trim() || "history rewritten",
        };
      } catch (err: unknown) {
        return {
          toolUsed: "git-filter-repo",
          ok: false,
          detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
        };
      }
    }

    if (tools.bfgAvailable) {
      try {
        const { stdout } = await exec(
          "bfg",
          ["--replace-text", replacementFile, cwd],
          { cwd, timeout: 600_000, maxBuffer: 50 * 1024 * 1024 },
        );
        // bfg leaves dangling refs; user must run `git reflog expire --expire=now --all && git gc --prune=now --aggressive`.
        return {
          toolUsed: "bfg",
          ok: true,
          detail: `${stdout.split("\n").length} lines emitted; run \`git reflog expire --expire=now --all && git gc --prune=now --aggressive\` next`,
        };
      } catch (err: unknown) {
        return {
          toolUsed: "bfg",
          ok: false,
          detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
        };
      }
    }

    return {
      toolUsed: "git-filter-repo",
      ok: false,
      detail:
        "Neither `git filter-repo` nor `bfg` is installed. Install one: " +
        "`pip install git-filter-repo` or `brew install bfg`.",
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
