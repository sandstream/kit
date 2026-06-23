/**
 * Post-pull / post-merge security audit.
 *
 * After a `git pull` (or merge) brings in teammates' changes, surface
 * anything that should trigger a security review BEFORE the next
 * `npm install` / `pnpm install` / deploy:
 *
 *   1. **New dependencies** in `package.json` — each one should be
 *      run through `kit triage` before it lands on disk.
 *   2. **Removed `.gitignore` entries** — someone deleting `.env*` or
 *      `*.pem` from the ignore list opens a leak vector.
 *   3. **Plaintext secrets** introduced in any committed file across
 *      the diff range (same SECRET_PATTERNS as scan-staged).
 *   4. **`.kit-allowlist.json` / `.kit-policy.json` changes** —
 *      relaxed enforcement is worth a second look.
 *   5. **`.kit.toml [secrets.keys]` changes** — keys added / removed.
 *
 * Wraps the existing scanner helpers; this module only does the diff
 * collection + per-category dispatch.
 */

import { findSecrets, type SecretFinding } from "./utils/redactSecrets.js";
import { exec } from "./utils/exec.js";

export interface PullAuditReport {
  baseRef: string;
  headRef: string;
  newDependencies: string[];
  removedDependencies: string[];
  removedGitignoreEntries: string[];
  newGitignoreEntries: string[];
  plaintextHits: { file: string; findings: SecretFinding[] }[];
  allowlistChanged: boolean;
  policyChanged: boolean;
  kitTomlChanged: boolean;
  changedFiles: string[];
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function tryGitShow(ref: string, path: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["show", `${ref}:${path}`], {
      cwd,
      timeout: 5_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function listChangedFiles(baseRef: string, headRef: string, cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["diff", "--name-only", "--diff-filter=AM", "-z", baseRef, headRef],
      { cwd, timeout: 10_000 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function diffDeps(
  before: PackageJson | null,
  after: PackageJson | null,
): { added: string[]; removed: string[] } {
  const beforeAll = new Set([
    ...Object.keys(before?.dependencies ?? {}),
    ...Object.keys(before?.devDependencies ?? {}),
  ]);
  const afterAll = new Set([
    ...Object.keys(after?.dependencies ?? {}),
    ...Object.keys(after?.devDependencies ?? {}),
  ]);
  return {
    added: [...afterAll].filter((name) => !beforeAll.has(name)),
    removed: [...beforeAll].filter((name) => !afterAll.has(name)),
  };
}

function diffLines(
  before: string | null,
  after: string | null,
): {
  added: string[];
  removed: string[];
} {
  const cleanup = (t: string | null): Set<string> => {
    if (!t) return new Set();
    return new Set(
      t
        .split("\n")
        .map((l) => {
          const i = l.indexOf("#");
          const stripped = i >= 0 ? l.slice(0, i) : l;
          return stripped.trim();
        })
        .filter((l) => l.length > 0),
    );
  };
  const b = cleanup(before);
  const a = cleanup(after);
  return {
    added: [...a].filter((line) => !b.has(line)),
    removed: [...b].filter((line) => !a.has(line)),
  };
}

export async function auditPull(
  cwd: string = process.cwd(),
  baseRef: string = "HEAD~1",
  headRef: string = "HEAD",
): Promise<PullAuditReport> {
  const report: PullAuditReport = {
    baseRef,
    headRef,
    newDependencies: [],
    removedDependencies: [],
    removedGitignoreEntries: [],
    newGitignoreEntries: [],
    plaintextHits: [],
    allowlistChanged: false,
    policyChanged: false,
    kitTomlChanged: false,
    changedFiles: [],
  };

  // 1. Dependencies
  const beforePkg = await tryGitShow(baseRef, "package.json", cwd);
  const afterPkg = await tryGitShow(headRef, "package.json", cwd);
  if (beforePkg || afterPkg) {
    try {
      const before = beforePkg ? (JSON.parse(beforePkg) as PackageJson) : null;
      const after = afterPkg ? (JSON.parse(afterPkg) as PackageJson) : null;
      const { added, removed } = diffDeps(before, after);
      report.newDependencies = added;
      report.removedDependencies = removed;
    } catch {
      // malformed package.json — skip
    }
  }

  // 2. .gitignore
  const beforeGi = await tryGitShow(baseRef, ".gitignore", cwd);
  const afterGi = await tryGitShow(headRef, ".gitignore", cwd);
  const giDiff = diffLines(beforeGi, afterGi);
  report.newGitignoreEntries = giDiff.added;
  report.removedGitignoreEntries = giDiff.removed;

  // 3. Plaintext secrets across all changed files
  const changed = await listChangedFiles(baseRef, headRef, cwd);
  report.changedFiles = changed;
  for (const path of changed) {
    const content = await tryGitShow(headRef, path, cwd);
    if (!content) continue;
    const findings = findSecrets(content);
    if (findings.length > 0) {
      report.plaintextHits.push({ file: path, findings });
    }
  }

  // 4 + 5. Allowlist / policy / kit.toml shape changes
  const allowlistBefore = await tryGitShow(baseRef, ".kit-allowlist.json", cwd);
  const allowlistAfter = await tryGitShow(headRef, ".kit-allowlist.json", cwd);
  report.allowlistChanged = (allowlistBefore ?? "") !== (allowlistAfter ?? "");
  const policyBefore = await tryGitShow(baseRef, ".kit-policy.json", cwd);
  const policyAfter = await tryGitShow(headRef, ".kit-policy.json", cwd);
  report.policyChanged = (policyBefore ?? "") !== (policyAfter ?? "");
  const tomlBefore = await tryGitShow(baseRef, ".kit.toml", cwd);
  const tomlAfter = await tryGitShow(headRef, ".kit.toml", cwd);
  report.kitTomlChanged = (tomlBefore ?? "") !== (tomlAfter ?? "");

  return report;
}

export function reportSeverity(report: PullAuditReport): "ok" | "warn" | "fail" {
  if (report.plaintextHits.length > 0) return "fail";
  if (report.removedGitignoreEntries.some((l) => /\.env|\.pem|\.key|id_rsa/.test(l))) {
    return "fail";
  }
  if (report.newDependencies.length > 0 || report.allowlistChanged || report.policyChanged) {
    return "warn";
  }
  return "ok";
}
