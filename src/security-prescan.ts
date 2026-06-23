/**
 * Multi-repo security prescan.
 *
 * `kit security prescan <path>` walks every git-repo under <path> and
 * produces a baseline-snapshot of cross-cutting security signals. Output:
 * `~/.kit/prescans/<timestamp>.jsonl` (raw findings) +
 * `<timestamp>-summary.md` (operator-facing rollup).
 *
 * Designed as the "first day onboarding" sweep — new operator points
 * kit at their `~/projects/` (or whatever root), gets one document
 * describing every actionable security gap across every repo.
 *
 * Default bundle (fast, ~30s for 10 repos):
 *   - secret-leak       gitleaks full history (delegated to gitleaks CLI)
 *   - gitignore-holes   missing .env* / *.pem / id_rsa / *.bak patterns
 *   - tracked-secrets   git ls-files matches secret-file patterns
 *   - branch-protection gh api repos/{owner}/{repo}/branches/main/protection
 *   - public-private    gh api repos/{owner}/{repo} --jq .private
 *
 * --deep adds:
 *   - npm-audit-high    npm audit --audit-level=high per repo with package.json
 *   - bumblebee         delegate to kit's existing supply-chain scanner
 *   - audit-gap         repos with [governance] but empty .kit-audit.jsonl
 *   - workflow-drift    repos missing .github/workflows/kit-security.yml
 *
 * Every check is BEST-EFFORT: missing tool (gitleaks not installed, gh not
 * authed, etc.) emits a "skipped" finding instead of failing the whole sweep.
 */

import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "./utils/exec.js";

const PRESCAN_DIR = join(homedir(), ".kit", "prescans");

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface PrescanFinding {
  timestamp: string;
  repo: string;
  category: string;
  severity: Severity;
  detail: string;
  remediation?: string;
}

/**
 * A prescan check is the smallest extensibility unit. Built-in checks live
 * in `BUILTIN_CHECKS`; callers (or future plugins) can pass additional
 * `extraChecks` via `PrescanOptions.checks` to extend the registry without
 * forking kit.
 *
 * Contract:
 * - `name` is a unique kebab-case slug. Used by --only / --skip filters.
 * - `tier === "deep"` checks only run when opts.deep is true.
 * - `scope === "global"` runs once for the whole prescan; "per-repo" runs
 *   per discovered repo. Global checks receive the prescan root as `repo`.
 * - `ctx.bumblebeeInstall` is set ONLY for deep mode + after the install
 *   succeeded. Checks that depend on it must defensively check for null.
 */
export interface PrescanCheckContext {
  bumblebeeInstall?: { binPath: string; catalogDir: string } | null;
}

export interface PrescanCheck {
  name: string;
  tier: "default" | "deep";
  scope: "per-repo" | "global";
  run: (repo: string, ctx: PrescanCheckContext) => Promise<PrescanFinding[]>;
}

export interface PrescanOptions {
  /** Root path to walk. Required. */
  root: string;
  /** Include --deep checks (npm-audit, bumblebee, audit-gap, workflow-drift). */
  deep?: boolean;
  /** Write report to disk. Default true; set false in tests. */
  persist?: boolean;
  /** Max repo-depth from root (default 4). */
  maxDepth?: number;
  /** Override report dir (test injection). */
  outDir?: string;
  /** Repo-path substrings to skip (e.g. third-party clones like "convex-backend"). */
  exclude?: string[];
  /**
   * Subset of check-names to run (whitelist). If unset, run all registered
   * checks. Mutually exclusive with `skipChecks` in practice — both can be
   * provided, only and skip stack (only first, then skip from the only-set).
   */
  onlyChecks?: string[];
  /** Check-names to omit. Applied AFTER onlyChecks. */
  skipChecks?: string[];
  /**
   * Additional checks beyond the built-in registry. Useful for plugins or
   * tests; built-in checks always run first (subject to filtering).
   */
  extraChecks?: PrescanCheck[];
}

export interface PrescanReport {
  startedAt: string;
  finishedAt: string;
  root: string;
  repoCount: number;
  findings: PrescanFinding[];
  reportPath?: string;
  summaryPath?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk <root> looking for git repos. Skips node_modules / dist / .git /
 * obvious build dirs. Returns absolute paths of every .git directory's
 * parent (= the repo root).
 */
async function findRepos(root: string, maxDepth: number): Promise<string[]> {
  const repos: string[] = [];
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    "out",
    "coverage",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
  ]);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    // Is dir itself a repo? Check for .git as dir or file (worktrees).
    if (await pathExists(join(dir, ".git"))) {
      repos.push(dir);
      return; // don't recurse into a repo
    }
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = (await readdir(dir, {
        withFileTypes: true,
        encoding: "utf-8",
      })) as unknown as Array<{ name: string; isDirectory(): boolean }>;
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = String(ent.name);
      if (name.startsWith(".") && name !== ".git") continue;
      if (SKIP_DIRS.has(name)) continue;
      await walk(join(dir, name), depth + 1);
    }
  }
  await walk(root, 0);
  return repos;
}

async function gitOriginHttpsUrl(repo: string): Promise<{ owner: string; name: string } | null> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "config", "--get", "remote.origin.url"], {
      timeout: 5000,
    });
    const url = stdout.trim();
    // git@github.com:owner/repo.git  OR  https://github.com/owner/repo(.git)?
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], name: m[2] };
    return null;
  } catch {
    return null;
  }
}

function finding(
  repo: string,
  category: string,
  severity: Severity,
  detail: string,
  remediation?: string,
): PrescanFinding {
  return {
    timestamp: new Date().toISOString(),
    repo,
    category,
    severity,
    detail,
    remediation,
  };
}

// ── Check: gitignore holes ─────────────────────────────────────────────────

const REQUIRED_GITIGNORE = [
  ".env",
  ".env.local",
  ".env.*.local",
  ".env.*.backup",
  "*.prod-backup",
  "*.pem",
  "id_rsa",
  ".kit/elevation.json",
];

async function checkGitignoreHoles(repo: string): Promise<PrescanFinding[]> {
  const path = join(repo, ".gitignore");
  let text = "";
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return [
      finding(
        repo,
        "gitignore-missing",
        "high",
        "no .gitignore in repo root",
        "add .gitignore with at least: .env*, *.pem, id_rsa",
      ),
    ];
  }
  const lines = text.split("\n").map((l) => l.trim());
  const missing = REQUIRED_GITIGNORE.filter((p) => !lines.includes(p));
  if (missing.length === 0) return [];
  return [
    finding(
      repo,
      "gitignore-holes",
      "medium",
      `missing ${missing.length} secret-leak patterns: ${missing.join(", ")}`,
      `append to .gitignore: ${missing.join(" ")}`,
    ),
  ];
}

// ── Check: tracked secret-shaped files ─────────────────────────────────────

async function checkTrackedSecretFiles(repo: string): Promise<PrescanFinding[]> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "ls-files"], {
      timeout: 15000,
      maxBuffer: 20_000_000,
    });
    const tracked = stdout.split("\n");
    const matches = tracked
      .filter((f) => /(?:^|\/)\.env(?:\.|$)|\.pem$|\.key$|id_rsa$|\.prod-backup$|\.bak$/.test(f))
      .filter(
        (f) =>
          // Allowlist anything that looks like a template / example / sample / patch / dist,
          // and node-modules / vendor / fixtures / third-party demo folders.
          !/\.(template|example|sample|dist|tmpl|patch|stub|mock|spec)$/.test(f) &&
          !/(?:^|\/)(node_modules|vendor|__tests__|tests?|fixtures?|demos?|private-demos?|examples?|samples?)\//.test(
            f,
          ),
      );
    if (matches.length === 0) return [];
    return [
      finding(
        repo,
        "tracked-secret-files",
        "critical",
        `${matches.length} tracked file(s) match secret-file pattern: ${matches.join(", ")}`,
        `git rm --cached <file> ; add to .gitignore ; rotate any leaked credential`,
      ),
    ];
  } catch {
    return [];
  }
}

// ── Check: gitleaks ────────────────────────────────────────────────────────

async function checkSecretLeakage(repo: string): Promise<PrescanFinding[]> {
  try {
    await exec("gitleaks", ["--version"], { timeout: 3000 });
  } catch {
    return [
      finding(
        repo,
        "secret-leak-skipped",
        "info",
        "gitleaks not installed — skipping",
        "install: https://github.com/gitleaks/gitleaks",
      ),
    ];
  }
  try {
    await exec(
      "gitleaks",
      ["detect", "--source", repo, "--redact", "--no-banner", "--exit-code", "1"],
      {
        timeout: 60_000,
      },
    );
    return [];
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = (e.stdout ?? "") + (e.stderr ?? "");
    const leakMatch = out.match(/\d+ leaks? found/i);
    return [
      finding(
        repo,
        "secret-leak",
        "critical",
        leakMatch ? leakMatch[0] : "gitleaks reported leaks (see report)",
        "review leaks; rotate; allowlist via .gitleaks.toml only AFTER revoking",
      ),
    ];
  }
}

// ── Check: branch protection + public/private (via gh CLI) ────────────────

async function checkGitHubMeta(repo: string): Promise<PrescanFinding[]> {
  const remote = await gitOriginHttpsUrl(repo);
  if (!remote) return [];
  const findings: PrescanFinding[] = [];
  try {
    const { stdout } = await exec(
      "gh",
      ["api", `repos/${remote.owner}/${remote.name}`, "--jq", ".private,.default_branch"],
      {
        timeout: 10_000,
      },
    );
    const [isPrivateStr, defaultBranch] = stdout.trim().split("\n");
    const isPrivate = isPrivateStr === "true";
    const branch = defaultBranch || "main";
    if (!isPrivate) {
      findings.push(
        finding(
          repo,
          "repo-public",
          "high",
          `repository is PUBLIC (${remote.owner}/${remote.name}) — any leaked credential in history is world-visible`,
          "consider whether truly intended; for private code, switch via Settings → Visibility",
        ),
      );
    }
    // Branch protection
    try {
      await exec(
        "gh",
        ["api", `repos/${remote.owner}/${remote.name}/branches/${branch}/protection`],
        {
          timeout: 10_000,
        },
      );
    } catch (err) {
      const e = err as { stderr?: string };
      if ((e.stderr ?? "").includes("404")) {
        findings.push(
          finding(
            repo,
            "branch-unprotected",
            "medium",
            `branch '${branch}' has no protection rules`,
            `Settings → Branches → Add protection rule for ${branch}`,
          ),
        );
      }
    }
  } catch {
    findings.push(
      finding(
        repo,
        "gh-skipped",
        "info",
        `gh CLI not authed or repo not on github.com — skipping repo meta`,
        "run: gh auth login",
      ),
    );
  }
  return findings;
}

// ── Deep check: npm audit ──────────────────────────────────────────────────

/**
 * Extract up to 3 representative package names from npm-audit's `vulnerabilities`
 * map for crit+high entries. Helps the operator know WHICH dep is exposed
 * without forcing them to re-run `npm audit` interactively.
 */
function topAuditPackages(data: unknown): string[] {
  const vulns = (data as { vulnerabilities?: Record<string, { severity?: string }> })
    ?.vulnerabilities;
  if (!vulns) return [];
  const top: string[] = [];
  for (const [name, info] of Object.entries(vulns)) {
    if (top.length >= 3) break;
    const sev = info?.severity?.toLowerCase();
    if (sev === "critical" || sev === "high") top.push(name);
  }
  return top;
}

async function checkNpmAudit(repo: string): Promise<PrescanFinding[]> {
  if (!(await pathExists(join(repo, "package.json")))) return [];
  if (!(await pathExists(join(repo, "package-lock.json")))) {
    return [
      finding(
        repo,
        "npm-audit-skipped",
        "info",
        "no package-lock.json — skipping npm audit",
        "run: npm install to generate lockfile",
      ),
    ];
  }
  const NPM_AUDIT_TIMEOUT_MS = 120_000; // 2 min — large lockfiles can be slow
  const NPM_AUDIT_BUFFER = 64 * 1024 * 1024; // 64 MB — monorepos emit large json
  const parseAndFormat = (stdout: string): PrescanFinding[] => {
    const data = JSON.parse(stdout);
    const high = data?.metadata?.vulnerabilities?.high ?? 0;
    const critical = data?.metadata?.vulnerabilities?.critical ?? 0;
    if (high + critical === 0) return [];
    const top = topAuditPackages(data);
    const where = top.length ? ` — top: ${top.join(", ")}` : "";
    return [
      finding(
        repo,
        "npm-audit",
        critical > 0 ? "critical" : "high",
        `${critical} critical + ${high} high vulnerabilities${where}`,
        "npm audit fix; review individual reports",
      ),
    ];
  };
  try {
    const { stdout } = await exec("npm", ["audit", "--audit-level=high", "--json"], {
      cwd: repo,
      timeout: NPM_AUDIT_TIMEOUT_MS,
      maxBuffer: NPM_AUDIT_BUFFER,
    });
    return parseAndFormat(stdout);
  } catch (err) {
    // npm audit exits non-zero when findings exist
    const e = err as { stdout?: string };
    if (e.stdout) {
      try {
        return parseAndFormat(e.stdout);
      } catch {
        /* fallthrough */
      }
    }
    return [
      finding(repo, "npm-audit-error", "info", "npm audit failed to parse", "manual investigation"),
    ];
  }
}

// ── Deep check: workflow drift ─────────────────────────────────────────────

async function checkWorkflowDrift(repo: string): Promise<PrescanFinding[]> {
  if (!(await pathExists(join(repo, ".github", "workflows")))) return [];
  const expectedFiles = ["kit-security.yml", "security.yml"];
  for (const f of expectedFiles) {
    if (await pathExists(join(repo, ".github", "workflows", f))) return [];
  }
  return [
    finding(
      repo,
      "workflow-drift",
      "low",
      "no kit-security workflow in .github/workflows/",
      "copy templates/github/kit-security.yml from kit",
    ),
  ];
}

// ── Deep check: bumblebee supply-chain exposure ────────────────────────────

/**
 * One-time staleness check for the bundled exposure catalog. Stale catalogs
 * mean the scanner is detecting old compromises only — new credential-stealing
 * supply-chain attacks won't surface. Surfaced as a single warning across the
 * whole prescan, not per-repo (the catalog is shared).
 */
async function checkBumblebeeCatalogStale(
  install: { binPath: string; catalogDir: string },
  root: string,
): Promise<PrescanFinding[]> {
  try {
    const { newestCatalogMtime, isCatalogStale, CATALOG_STALE_AFTER_DAYS } =
      await import("./bumblebee.js");
    const mtime = await newestCatalogMtime(install.catalogDir);
    if (mtime === null) {
      return [
        finding(
          root,
          "bumblebee-catalog-missing",
          "medium",
          `bumblebee threat_intel catalog directory empty: ${install.catalogDir}`,
          `clear ~/.kit/tools/bumblebee and run any deep scan to re-download`,
        ),
      ];
    }
    const { stale, ageDays } = isCatalogStale(mtime, Date.now());
    if (stale) {
      return [
        finding(
          root,
          "bumblebee-catalog-stale",
          "medium",
          `bumblebee threat_intel catalog is ${ageDays} days old (threshold: ${CATALOG_STALE_AFTER_DAYS}d) — new supply-chain compromises may not be detected`,
          `clear ~/.kit/tools/bumblebee to force a fresh download next deep scan`,
        ),
      ];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Per-repo bumblebee scan. Returns one finding per detected exposure.
 * `install` is hoisted to the caller so the binary is fetched ONCE per
 * prescan run, not 27× — bumblebee install can do an HTTP download.
 */
async function checkBumblebee(
  repo: string,
  install: { binPath: string; catalogDir: string },
): Promise<PrescanFinding[]> {
  try {
    const { runScan } = await import("./bumblebee.js");
    const { outcome, error } = await runScan({
      install: install as unknown as Parameters<typeof runScan>[0]["install"],
      profile: "project",
      roots: [repo],
      maxDuration: "60s",
      timeoutMs: 90_000,
    });
    if (error || !outcome) {
      // Don't fail OPEN silently: a scan that errored/timed out is NOT the same
      // as "no compromised packages found". Surface it so "we couldn't scan" is
      // visible in the verdict rather than indistinguishable from a clean run.
      return [
        finding(
          repo,
          "supply-chain",
          "info",
          "bumblebee known-compromise scan did not complete (timeout or error) — supply-chain results may be incomplete",
          "re-run `kit check`; if it persists, clear the bumblebee cache or scan manually",
        ),
      ];
    }
    if (!outcome.findings.length) return [];
    return outcome.findings.map((f) =>
      finding(
        repo,
        "supply-chain",
        (f.severity?.toLowerCase() as Severity) ?? "medium",
        `${f.ecosystem}/${f.packageName}@${f.version} matches catalog ${f.catalogName} (${f.catalogId}) in ${f.sourceFile}`,
        "investigate package; remove if not directly required; pin to last-known-good version",
      ),
    );
  } catch {
    return [
      finding(
        repo,
        "supply-chain",
        "info",
        "bumblebee known-compromise scan errored — supply-chain results may be incomplete",
        "re-run `kit check`; verify the bumblebee binary and catalog are intact",
      ),
    ];
  }
}

// ── Deep check: audit-log gap ──────────────────────────────────────────────

async function checkAuditGap(repo: string): Promise<PrescanFinding[]> {
  const kitToml = await pathExists(join(repo, ".kit.toml"));
  if (!kitToml) return [];
  const auditFile = join(repo, ".kit-audit.jsonl");
  if (!(await pathExists(auditFile))) {
    return [
      finding(
        repo,
        "audit-gap",
        "info",
        "kit governance configured but .kit-audit.jsonl missing",
        "run any kit sensitive op to bootstrap; verify [governance.audit].enabled = true",
      ),
    ];
  }
  return [];
}

// ── Built-in check registry ────────────────────────────────────────────────

/**
 * Built-in checks. New checks should be added here; external plugins can
 * pass additional checks via `PrescanOptions.extraChecks`.
 */
export const BUILTIN_CHECKS: PrescanCheck[] = [
  {
    name: "gitignore-holes",
    tier: "default",
    scope: "per-repo",
    run: (repo) => checkGitignoreHoles(repo),
  },
  {
    name: "tracked-secret-files",
    tier: "default",
    scope: "per-repo",
    run: (repo) => checkTrackedSecretFiles(repo),
  },
  {
    name: "secret-leak",
    tier: "default",
    scope: "per-repo",
    run: (repo) => checkSecretLeakage(repo),
  },
  { name: "github-meta", tier: "default", scope: "per-repo", run: (repo) => checkGitHubMeta(repo) },
  { name: "npm-audit", tier: "deep", scope: "per-repo", run: (repo) => checkNpmAudit(repo) },
  {
    name: "workflow-drift",
    tier: "deep",
    scope: "per-repo",
    run: (repo) => checkWorkflowDrift(repo),
  },
  { name: "audit-gap", tier: "deep", scope: "per-repo", run: (repo) => checkAuditGap(repo) },
  {
    name: "bumblebee-catalog-stale",
    tier: "deep",
    scope: "global",
    run: async (root, ctx) =>
      ctx.bumblebeeInstall ? await checkBumblebeeCatalogStale(ctx.bumblebeeInstall, root) : [],
  },
  {
    name: "bumblebee",
    tier: "deep",
    scope: "per-repo",
    run: async (repo, ctx) =>
      ctx.bumblebeeInstall ? await checkBumblebee(repo, ctx.bumblebeeInstall) : [],
  },
];

/**
 * Apply --only / --skip filters AFTER tier-filtering.
 */
function selectChecks(
  all: PrescanCheck[],
  deep: boolean,
  only?: string[],
  skip?: string[],
): PrescanCheck[] {
  const inTier = all.filter((c) => deep || c.tier !== "deep");
  const onlySet = only && only.length > 0 ? new Set(only) : null;
  const skipSet = skip && skip.length > 0 ? new Set(skip) : new Set<string>();
  return inTier.filter((c) => (onlySet === null || onlySet.has(c.name)) && !skipSet.has(c.name));
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function runPrescan(opts: PrescanOptions): Promise<PrescanReport> {
  const startedAt = new Date().toISOString();
  const allRepos = await findRepos(opts.root, opts.maxDepth ?? 4);
  const excludes = opts.exclude ?? [];
  const repos =
    excludes.length === 0 ? allRepos : allRepos.filter((r) => !excludes.some((p) => r.includes(p)));
  const findings: PrescanFinding[] = [];

  // Hoist bumblebee install once for the whole run (deep mode only).
  // Failure to ensure → ctx.bumblebeeInstall stays null and per-check
  // run() callbacks defensively return [].
  let bumblebeeInstall: { binPath: string; catalogDir: string } | null = null;
  if (opts.deep) {
    try {
      const { ensureBumblebee } = await import("./bumblebee.js");
      const { install } = await ensureBumblebee({ allowDownload: true });
      if (install) bumblebeeInstall = install as { binPath: string; catalogDir: string };
    } catch {
      // Best-effort — leave install null.
    }
  }

  const ctx: PrescanCheckContext = { bumblebeeInstall };
  const checks = selectChecks(
    [...BUILTIN_CHECKS, ...(opts.extraChecks ?? [])],
    Boolean(opts.deep),
    opts.onlyChecks,
    opts.skipChecks,
  );
  const globalChecks = checks.filter((c) => c.scope === "global");
  const perRepoChecks = checks.filter((c) => c.scope === "per-repo");

  // Globals first (e.g. bumblebee-catalog-stale): they may influence later
  // per-repo decisions, and they're typically O(1) rather than O(repos).
  for (const check of globalChecks) {
    findings.push(...(await check.run(opts.root, ctx)));
  }

  for (const repo of repos) {
    for (const check of perRepoChecks) {
      findings.push(...(await check.run(repo, ctx)));
    }
  }

  const finishedAt = new Date().toISOString();
  const report: PrescanReport = {
    startedAt,
    finishedAt,
    root: opts.root,
    repoCount: repos.length,
    findings,
  };

  if (opts.persist !== false) {
    const outDir = opts.outDir ?? PRESCAN_DIR;
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const stamp = startedAt.replace(/[:.]/g, "-");
    const reportPath = join(outDir, `${stamp}.jsonl`);
    const summaryPath = join(outDir, `${stamp}-summary.md`);
    const jsonl = findings.map((f) => JSON.stringify(f)).join("\n") + "\n";
    await writeFile(reportPath, jsonl, { encoding: "utf-8", mode: 0o600 });
    await writeFile(summaryPath, renderSummary(report), { encoding: "utf-8", mode: 0o600 });
    report.reportPath = reportPath;
    report.summaryPath = summaryPath;
  }

  return report;
}

export function renderSummary(report: PrescanReport): string {
  const sevOrder: Severity[] = ["critical", "high", "medium", "low", "info"];
  const bySev = new Map<Severity, PrescanFinding[]>();
  for (const f of report.findings) {
    const arr = bySev.get(f.severity) ?? [];
    arr.push(f);
    bySev.set(f.severity, arr);
  }
  const lines: string[] = [];
  lines.push(`# kit prescan report`);
  lines.push("");
  lines.push(`- **Root**: \`${report.root}\``);
  lines.push(`- **Started**: ${report.startedAt}`);
  lines.push(`- **Finished**: ${report.finishedAt}`);
  lines.push(`- **Repos scanned**: ${report.repoCount}`);
  lines.push(`- **Total findings**: ${report.findings.length}`);
  lines.push("");
  for (const sev of sevOrder) {
    const arr = bySev.get(sev) ?? [];
    if (arr.length === 0) continue;
    lines.push(`## ${sev.toUpperCase()} (${arr.length})`);
    lines.push("");
    for (const f of arr) {
      lines.push(`### ${f.repo} — ${f.category}`);
      lines.push(`${f.detail}`);
      if (f.remediation) lines.push(`> **Fix**: ${f.remediation}`);
      lines.push("");
    }
  }
  if (report.findings.length === 0) {
    lines.push(`## All clean`);
    lines.push("");
    lines.push("No findings across all scanned repos. Re-run periodically to detect drift.");
  }
  return lines.join("\n");
}

// ── Diff between two prescan reports ───────────────────────────────────────

export interface PrescanDiff {
  /** Findings present in B but not A — new regressions since the baseline. */
  added: PrescanFinding[];
  /** Findings present in A but not B — fixed (or excluded) since baseline. */
  removed: PrescanFinding[];
  /** Findings present in both — persistent. */
  unchanged: PrescanFinding[];
}

/**
 * A finding's identity is (repo, category, detail). Severity isn't part of
 * the key — a severity-only change still counts as the same finding (caller
 * can compare arr.severity manually if interested).
 */
function findingKey(f: PrescanFinding): string {
  return `${f.repo}\x00${f.category}\x00${f.detail}`;
}

export function diffReports(a: PrescanReport, b: PrescanReport): PrescanDiff {
  const aKeys = new Map(a.findings.map((f) => [findingKey(f), f]));
  const bKeys = new Map(b.findings.map((f) => [findingKey(f), f]));
  const added: PrescanFinding[] = [];
  const removed: PrescanFinding[] = [];
  const unchanged: PrescanFinding[] = [];
  for (const [k, f] of bKeys) {
    if (aKeys.has(k)) unchanged.push(f);
    else added.push(f);
  }
  for (const [k, f] of aKeys) {
    if (!bKeys.has(k)) removed.push(f);
  }
  return { added, removed, unchanged };
}

export async function loadReport(jsonlPath: string): Promise<PrescanReport> {
  const text = await readFile(jsonlPath, "utf-8");
  const findings: PrescanFinding[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      findings.push(JSON.parse(t) as PrescanFinding);
    } catch {
      // Skip malformed lines — JSONL parsers should be tolerant.
    }
  }
  // The JSONL only stores findings; reconstruct minimal report envelope.
  return {
    startedAt: findings[0]?.timestamp ?? "",
    finishedAt: findings[findings.length - 1]?.timestamp ?? "",
    root: "",
    repoCount: new Set(findings.map((f) => f.repo)).size,
    findings,
  };
}

export function renderDiff(diff: PrescanDiff): string {
  const lines: string[] = [];
  lines.push(`# kit prescan diff`);
  lines.push("");
  lines.push(`- **Added (regressions)**: ${diff.added.length}`);
  lines.push(`- **Removed (fixed)**: ${diff.removed.length}`);
  lines.push(`- **Unchanged (persistent)**: ${diff.unchanged.length}`);
  lines.push("");

  if (diff.added.length) {
    lines.push(`## REGRESSIONS — new findings since baseline (${diff.added.length})`);
    lines.push("");
    for (const f of diff.added) {
      lines.push(`### ${f.repo} — ${f.category} (${f.severity})`);
      lines.push(f.detail);
      if (f.remediation) lines.push(`> **Fix**: ${f.remediation}`);
      lines.push("");
    }
  }

  if (diff.removed.length) {
    lines.push(`## FIXED — gone since baseline (${diff.removed.length})`);
    lines.push("");
    for (const f of diff.removed) {
      lines.push(`### ${f.repo} — ${f.category} (was ${f.severity})`);
      lines.push(f.detail);
      lines.push("");
    }
  }

  if (diff.added.length === 0 && diff.removed.length === 0) {
    lines.push(`## No drift`);
    lines.push("");
    lines.push(
      `${diff.unchanged.length} finding(s) carried over unchanged. No regressions, no fixes.`,
    );
  }

  return lines.join("\n");
}
