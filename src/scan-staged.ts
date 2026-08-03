import { findSecrets, type SecretFinding } from "./utils/redactSecrets.js";
import { isTestOrFixturePath } from "./utils/test-paths.js";
import { exec } from "./utils/exec.js";

export interface StagedHit {
  file: string;
  findings: SecretFinding[];
  /**
   * True when the file is test/fixture material. Fake credentials live there by design —
   * kit's own audit-redaction test MUST contain a secret-shaped key to prove the
   * redaction works — so these are reported and do NOT block. The repo-wide grep in
   * check-security.ts already made this call; this gate did not, so it blocked the commit
   * that added that test, and the only escape was `--no-verify`, which disables the whole
   * hook. Reported rather than dropped: no false green, just no false block.
   */
  advisory?: boolean;
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

  const hits: StagedHit[] = [];
  for (const path of paths) {
    // Read the staged blob (`git show :file`) so a developer can't bypass
    // by un-staging the change after the hook fires.
    let content: string;
    try {
      const { stdout } = await exec("git", ["show", `:${path}`], {
        cwd,
        timeout: 5_000,
        // Raised from 1 MiB so realistic staged text files are scanned from the STAGED blob, not
        // skipped. (Was 1 MiB — a >1 MiB staged blob overflowed and fell through to the bypass.)
        maxBuffer: 25 * 1024 * 1024,
      });
      content = stdout;
    } catch {
      // The staged blob could not be read (too large even for the raised cap, or unreadable). Do
      // NOT fall back to the working copy: it can diverge from what is being committed (stage the
      // secret, then edit the working copy clean) — exactly the un-stage bypass this scanner
      // exists to prevent. Fail closed: flag it so the commit is blocked and handled explicitly.
      hits.push({
        file: path,
        findings: [
          {
            label: "unscannable staged blob (fail-closed)",
            preview: "staged content could not be read to scan for secrets — verify manually",
          },
        ],
      });
      continue;
    }
    const findings = findSecrets(content);
    if (findings.length > 0) {
      hits.push({ file: path, findings, ...(isTestOrFixturePath(path) ? { advisory: true } : {}) });
    }
  }
  return hits;
}
