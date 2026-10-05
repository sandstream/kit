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
  let hasHead = true;
  try {
    // `git diff --cached` compares the index to HEAD; on a fresh repo there
    // is no HEAD yet, which makes the call exit non-zero. Use the empty-tree
    // SHA as the comparison base in that case so first-ever-commit hooks
    // still get scanned.
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
    const findings = hasHead
      ? await netNewFindings(cwd, path, findSecrets(content))
      : findSecrets(content);
    if (findings.length > 0) {
      hits.push({ file: path, findings, ...(isTestOrFixturePath(path) ? { advisory: true } : {}) });
    }
  }
  return hits;
}

/**
 * Drops the findings HEAD's copy of the file already holds, counted per label and preview, so
 * only what this commit introduces blocks it. A finding that is already committed is not news
 * to the hook, and blocking every later edit to that file (a CHANGELOG, a doc example) left
 * `--no-verify`, which disables the whole hook, as the only way out. A second copy of a
 * committed secret still counts as new. The staged blob is still what gets scanned.
 */
async function netNewFindings(
  cwd: string,
  path: string,
  staged: SecretFinding[],
): Promise<SecretFinding[]> {
  if (staged.length === 0) return staged;
  let before: string;
  try {
    const { stdout } = await exec("git", ["show", `HEAD:${path}`], {
      cwd,
      timeout: 5_000,
      maxBuffer: 25 * 1024 * 1024,
    });
    before = stdout;
  } catch {
    // Not in HEAD (added file) or unreadable: everything staged is new.
    return staged;
  }
  const remaining = new Map<string, number>();
  for (const f of findSecrets(before)) {
    const key = `${f.label}\0${f.preview}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return staged.filter((f) => {
    const key = `${f.label}\0${f.preview}`;
    const left = remaining.get(key) ?? 0;
    if (left === 0) return true;
    remaining.set(key, left - 1);
    return false;
  });
}
