import { readFile } from "node:fs/promises";
import { findSecrets, type SecretFinding } from "./utils/redactSecrets.js";
import { exec } from "./utils/exec.js";

export interface StagedHit {
  file: string;
  findings: SecretFinding[];
}

/**
 * Reads the list of staged file paths from git, then scans each blob for
 * SECRET_PATTERNS. Returns one entry per file that has at least one match.
 *
 * Operates on the staged blob (`git show :file`) rather than the working
 * copy, so a developer can't bypass the check by un-staging the file after
 * the hook fires. NUL-delimited path parsing keeps newlines + spaces in
 * filenames safe.
 */
export async function scanStagedFiles(cwd: string = process.cwd()): Promise<StagedHit[]> {
  let paths: string[];
  try {
    // `git diff --cached` compares the index to HEAD; on a fresh repo there
    // is no HEAD yet, which makes the call exit non-zero. Use the empty-tree
    // SHA as the comparison base in that case so first-ever-commit hooks
    // still get scanned.
    let hasHead = true;
    try {
      await exec("git", ["rev-parse", "--verify", "HEAD"], {
        cwd,
        timeout: 3_000,
      });
    } catch {
      hasHead = false;
    }
    const args = hasHead
      ? ["diff", "--cached", "--name-only", "--diff-filter=AM", "-z"]
      : [
          "diff",
          "--cached",
          "--name-only",
          "--diff-filter=AM",
          "-z",
          "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        ]; // Git's well-known empty tree
    const { stdout } = await exec("git", args, { cwd, timeout: 5_000 });
    paths = stdout.split("\0").filter(Boolean);
  } catch {
    // not a git repo, or git missing — let hook fall through silently
    return [];
  }

  const { resolve } = await import("node:path");
  const hits: StagedHit[] = [];
  for (const path of paths) {
    // Read the staged blob (`git show :file`) so a developer can't bypass
    // by un-staging the change after the hook fires. Cap at 1 MiB.
    let content: string;
    try {
      const { stdout } = await exec("git", ["show", `:${path}`], {
        cwd,
        timeout: 5_000,
        maxBuffer: 1 * 1024 * 1024,
      });
      content = stdout;
    } catch {
      try {
        content = await readFile(resolve(cwd, path), "utf-8");
      } catch {
        continue;
      }
    }
    const findings = findSecrets(content);
    if (findings.length > 0) {
      hits.push({ file: path, findings });
    }
  }
  return hits;
}
