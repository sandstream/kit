import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { classifyGuardDog } from "./guarddog.js";
import { buildSemgrepArgs, semgrepConfig } from "./scanners.js";
import { ruleForCheck, type RuleRef } from "./rules/catalog.js";
import {
  ensureBumblebee,
  runScan,
  maxSeverity,
  newestCatalogMtime,
  isCatalogStale,
  type BumblebeeFinding,
} from "./bumblebee.js";

const exec = promisify(execFile);

function envFlagDisabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["0", "false", "off", "no"].includes(value.toLowerCase());
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "on", "yes"].includes(value.toLowerCase());
}

/** Map a bumblebee severity label to the SecurityCheckResult severity scale. */
function toResultSeverity(label: string | null): SecurityCheckResult["severity"] {
  switch ((label ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      // A known-compromise match with an unrecognized label is still serious.
      return "high";
  }
}

export interface SecurityCheckResult {
  category: "dependency" | "exposure" | "supply-chain" | "secrets" | `self-audit/${string}`;
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  severity?: "critical" | "high" | "medium" | "low";
  files?: string[]; // Files with issues (for secrets scan)
  suggestion?: string; // Installation or remediation instructions
  rule?: RuleRef; // citation for the rule this check enforces (CWE/OWASP), if mapped
}

/**
 * Run npm audit and check for high/critical vulnerabilities
 */
async function checkNpmAudit(): Promise<SecurityCheckResult> {
  try {
    // Check if package.json exists
    await access(resolve(process.cwd(), "package.json"));
  } catch {
    return {
      category: "dependency",
      name: "npm audit",
      status: "skip",
      detail: "no package.json found",
    };
  }

  try {
    const { stdout } = await exec("npm", ["audit", "--audit-level=high", "--json"], {
      timeout: 30_000,
    });
    // Exit 0 = npm found nothing >= high. But a broken / odd npm that exits 0
    // with no report must NOT be read as a clean pass — be honest (warn), don't
    // false-green.
    if (!stdout || !stdout.trim()) {
      return {
        category: "dependency",
        name: "npm audit",
        status: "warn",
        detail: "npm audit exited 0 but produced no report — could not confirm (unverified)",
        severity: "low",
      };
    }
    return {
      category: "dependency",
      name: "npm audit",
      status: "pass",
      detail: "no high/critical vulnerabilities",
    };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "stdout" in error) {
      try {
        const auditResult = JSON.parse(error.stdout as string);
        const vulnerabilities = auditResult.metadata?.vulnerabilities || {};
        const high = vulnerabilities.high || 0;
        const critical = vulnerabilities.critical || 0;

        if (high > 0 || critical > 0) {
          return {
            category: "dependency",
            name: "npm audit",
            status: "fail",
            detail: `${critical} critical, ${high} high vulnerabilities`,
            severity: critical > 0 ? "critical" : "high",
          };
        }
      } catch {
        // JSON parse failed, treat as fail
      }
    }

    return {
      category: "dependency",
      name: "npm audit",
      status: "fail",
      detail: "audit check failed",
      severity: "high",
    };
  }
}

/**
 * Run pip-audit for Python dependencies
 */
async function checkPipAudit(): Promise<SecurityCheckResult> {
  try {
    // Check if requirements.txt exists
    await access(resolve(process.cwd(), "requirements.txt"));
  } catch {
    return {
      category: "dependency",
      name: "pip-audit",
      status: "skip",
      detail: "no requirements.txt found",
    };
  }

  // Resolve pip-audit mise-first (commonly a pipx / `mise use -g` global, off PATH
  // when mise isn't activated); fall back to the bare name for non-mise installs.
  const pipAuditBin = (await resolveToolBin("pip-audit")) ?? "pip-audit";
  try {
    // Check if pip-audit is installed
    await exec(pipAuditBin, ["--version"], { timeout: 5_000 });
  } catch {
    return {
      category: "dependency",
      name: "pip-audit",
      status: "warn",
      detail: "pip-audit not installed (run: pip install pip-audit)",
      severity: "medium",
    };
  }

  try {
    const { stdout } = await exec(pipAuditBin, ["--format=json"], {
      timeout: 30_000,
    });

    const result = JSON.parse(stdout);
    const vulns = result.dependencies || [];

    if (vulns.length === 0) {
      return {
        category: "dependency",
        name: "pip-audit",
        status: "pass",
        detail: "no vulnerabilities found",
      };
    }

    const highSeverity = vulns.filter((v: { vulnerabilities?: Array<{ severity?: string }> }) =>
      v.vulnerabilities?.some((vuln) => vuln.severity === "high" || vuln.severity === "critical"),
    ).length;

    return {
      category: "dependency",
      name: "pip-audit",
      status: highSeverity > 0 ? "fail" : "warn",
      detail: `${vulns.length} vulnerable dependencies`,
      severity: highSeverity > 0 ? "high" : "medium",
    };
  } catch {
    return {
      category: "dependency",
      name: "pip-audit",
      status: "fail",
      detail: "audit check failed",
      severity: "high",
    };
  }
}

/**
 * Check if .env files are in .gitignore
 */
async function checkEnvGitignored(): Promise<SecurityCheckResult> {
  try {
    const gitignoreContent = await readFile(resolve(process.cwd(), ".gitignore"), "utf-8");

    const envPatterns = [".env", ".env.local", ".env.*.local"];
    const missingPatterns = envPatterns.filter((pattern) => !gitignoreContent.includes(pattern));

    if (missingPatterns.length === 0) {
      return {
        category: "secrets",
        name: ".env gitignored",
        status: "pass",
        detail: "all .env patterns in .gitignore",
      };
    }

    return {
      category: "secrets",
      name: ".env gitignored",
      status: "warn",
      detail: `missing patterns: ${missingPatterns.join(", ")}`,
      severity: "high",
    };
  } catch {
    return {
      category: "secrets",
      name: ".env gitignored",
      status: "warn",
      detail: ".gitignore not found",
      severity: "medium",
    };
  }
}

/**
 * Check if package-lock.json or requirements.txt are committed
 */
async function checkLockfilesCommitted(): Promise<SecurityCheckResult[]> {
  const results: SecurityCheckResult[] = [];

  // Check package-lock.json
  try {
    await access(resolve(process.cwd(), "package.json"));

    try {
      const { stdout } = await exec("git", ["ls-files", "package-lock.json"], {
        timeout: 5_000,
      });

      if (stdout.trim()) {
        results.push({
          category: "supply-chain",
          name: "package-lock.json",
          status: "pass",
          detail: "committed to git",
        });
      } else {
        results.push({
          category: "supply-chain",
          name: "package-lock.json",
          status: "fail",
          detail: "not committed to git",
          severity: "high",
        });
      }
    } catch {
      results.push({
        category: "supply-chain",
        name: "package-lock.json",
        status: "warn",
        detail: "git check failed (not in a git repo?)",
        severity: "low",
      });
    }
  } catch {
    // No package.json, skip
  }

  // Check requirements.txt
  try {
    await access(resolve(process.cwd(), "requirements.txt"));

    try {
      const { stdout } = await exec("git", ["ls-files", "requirements.txt"], {
        timeout: 5_000,
      });

      if (stdout.trim()) {
        results.push({
          category: "supply-chain",
          name: "requirements.txt",
          status: "pass",
          detail: "committed to git",
        });
      } else {
        results.push({
          category: "supply-chain",
          name: "requirements.txt",
          status: "fail",
          detail: "not committed to git",
          severity: "high",
        });
      }
    } catch {
      results.push({
        category: "supply-chain",
        name: "requirements.txt",
        status: "warn",
        detail: "git check failed (not in a git repo?)",
        severity: "low",
      });
    }
  } catch {
    // No requirements.txt, skip
  }

  return results;
}

/**
 * Check if local services are exposed to internet
 */
async function checkServiceExposure(): Promise<SecurityCheckResult[]> {
  const results: SecurityCheckResult[] = [];

  // Check Ollama (common port 11434)
  try {
    const { stdout: ollamaCheck } = await exec(
      "sh",
      ["-c", "command -v ollama && ollama ps 2>/dev/null || echo 'not running'"],
      { timeout: 5_000 },
    );

    if (ollamaCheck.includes("not running")) {
      results.push({
        category: "exposure",
        name: "Ollama",
        status: "skip",
        detail: "not running",
      });
    } else {
      // Check if listening on 0.0.0.0 (exposed) or 127.0.0.1 (localhost only)
      try {
        const { stdout: netstat } = await exec(
          "sh",
          [
            "-c",
            "ss -tlnp 2>/dev/null | grep :11434 || netstat -tlnp 2>/dev/null | grep :11434 || echo 'no listener'",
          ],
          { timeout: 5_000 },
        );

        if (netstat.includes("0.0.0.0:11434") || netstat.includes(":::11434")) {
          results.push({
            category: "exposure",
            name: "Ollama",
            status: "warn",
            detail: "exposed on all interfaces (0.0.0.0)",
            severity: "medium",
          });
        } else if (netstat.includes("127.0.0.1:11434")) {
          results.push({
            category: "exposure",
            name: "Ollama",
            status: "pass",
            detail: "localhost only",
          });
        } else {
          results.push({
            category: "exposure",
            name: "Ollama",
            status: "skip",
            detail: "could not determine exposure",
          });
        }
      } catch {
        results.push({
          category: "exposure",
          name: "Ollama",
          status: "skip",
          detail: "could not check network exposure",
        });
      }
    }
  } catch {
    results.push({
      category: "exposure",
      name: "Ollama",
      status: "skip",
      detail: "not installed",
    });
  }

  // Check Remote API (common port 3199)
  try {
    const { stdout: netstat } = await exec(
      "sh",
      [
        "-c",
        "ss -tlnp 2>/dev/null | grep :3199 || netstat -tlnp 2>/dev/null | grep :3199 || echo 'no listener'",
      ],
      { timeout: 5_000 },
    );

    if (netstat.includes("no listener")) {
      results.push({
        category: "exposure",
        name: "Remote API",
        status: "skip",
        detail: "not running on port 3199",
      });
    } else if (netstat.includes("0.0.0.0:3199") || netstat.includes(":::3199")) {
      results.push({
        category: "exposure",
        name: "Remote API",
        status: "warn",
        detail: "exposed on all interfaces (verify firewall)",
        severity: "medium",
      });
    } else {
      results.push({
        category: "exposure",
        name: "Remote API",
        status: "pass",
        detail: "localhost only",
      });
    }
  } catch {
    results.push({
      category: "exposure",
      name: "Remote API",
      status: "skip",
      detail: "could not check network exposure",
    });
  }

  return results;
}

/**
 * Check if dependencies use pinned versions
 */
async function checkPinnedVersions(): Promise<SecurityCheckResult> {
  const unpinned: string[] = [];

  // Check package.json
  try {
    const packageJsonContent = await readFile(resolve(process.cwd(), "package.json"), "utf-8");
    const packageJson = JSON.parse(packageJsonContent);

    const checkDeps = (deps: Record<string, string> | undefined) => {
      if (!deps) return;
      for (const [name, version] of Object.entries(deps)) {
        // Check for range specifiers: ^, ~, >, <, >=, <=, *, x
        if (/^[~^><=*x]|[*x]$/.test(version)) {
          unpinned.push(`${name}@${version}`);
        }
      }
    };

    checkDeps(packageJson.dependencies);
    checkDeps(packageJson.devDependencies);
  } catch {
    // No package.json or parse error
  }

  // Check requirements.txt
  try {
    const requirementsContent = await readFile(resolve(process.cwd(), "requirements.txt"), "utf-8");

    for (const line of requirementsContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Check for range specifiers: >=, >, ~=, !=
      if (/[>~!]=?/.test(trimmed)) {
        unpinned.push(trimmed.split(/\s+/)[0]);
      }
    }
  } catch {
    // No requirements.txt or read error
  }

  if (unpinned.length > 0) {
    return {
      category: "supply-chain",
      name: "pinned versions",
      status: "warn",
      detail: `${unpinned.length} unpinned dependencies`,
      severity: "medium",
    };
  }

  return {
    category: "supply-chain",
    name: "pinned versions",
    status: "pass",
    detail: "all dependencies pinned",
  };
}

/**
 * Count trufflehog `--json` findings split by Verified (live) vs unverified. Pure.
 *
 * trufflehog prefixes an info LOG line ({"level":...}); only DetectorName lines are
 * findings. `Verified: true` = trufflehog reached the provider and the credential
 * WORKS (a real, live leak). Unverified = secret-SHAPED but unconfirmed — very often
 * test fixtures / example connection strings / docs. A DetectorName line that won't
 * parse is counted conservatively as unverified (surfaced, just not as critical).
 */
export function classifyTrufflehogFindings(stdout: string): {
  verified: number;
  unverified: number;
} {
  let verified = 0;
  let unverified = 0;
  for (const line of stdout.trim().split("\n")) {
    if (!line.includes('"DetectorName"')) continue;
    try {
      const j = JSON.parse(line) as { Verified?: boolean };
      if (j.Verified === true) verified++;
      else unverified++;
    } catch {
      unverified++;
    }
  }
  return { verified, unverified };
}

/**
 * Scan for secrets in code using trufflehog or basic pattern matching
 */
async function checkSecretsInCode(): Promise<SecurityCheckResult> {
  try {
    // Check if we're in a git repo
    await exec("git", ["rev-parse", "--git-dir"], { timeout: 5_000 });
  } catch {
    return {
      category: "secrets",
      name: "secrets scan",
      status: "skip",
      detail: "not a git repository",
    };
  }

  // Deep scan with trufflehog — resolve mise-first so a mise-installed one is
  // used (kit provisions it as a default), not just a bare-PATH one. Throwing
  // when it's absent falls through to the basic pattern-matching below.
  try {
    const trufflehogBin = await resolveToolBin("trufflehog");
    if (!trufflehogBin) throw new Error("trufflehog not installed");

    try {
      // Scan GIT (committed content) — not the raw filesystem. `filesystem .`
      // walks node_modules (times out) and flags gitignored local files like
      // `.env.production.local` that were never committed (false positives).
      // Git mode is fast and only sees what's actually in the repo's history.
      const { stdout } = await exec(
        trufflehogBin,
        ["git", `file://${process.cwd()}`, "--json", "--no-update"],
        { timeout: 90_000 },
      );

      // Split verified-live from unverified (#noise-reduction). Only a VERIFIED
      // secret — one trufflehog confirmed still works — is a critical fail (rotate
      // now). Unverified secret-shaped strings (overwhelmingly test fixtures /
      // example connection strings) are a warn to review, not a release-blocking
      // critical. Avoids failing a clean repo on its own test data.
      const { verified, unverified } = classifyTrufflehogFindings(stdout);

      if (verified > 0) {
        return {
          category: "secrets",
          name: "secrets scan",
          status: "fail",
          detail: `${verified} VERIFIED-LIVE secret(s) in git history -rotate now; run: trufflehog git file://.`,
          severity: "critical",
        };
      }
      if (unverified > 0) {
        return {
          category: "secrets",
          name: "secrets scan",
          status: "warn",
          detail: `${unverified} unverified secret-shaped string(s) in git history (0 verified-live) — review for test/example data: trufflehog git file://.`,
          severity: "medium",
        };
      }

      return {
        category: "secrets",
        name: "secrets scan",
        status: "pass",
        detail: "no committed secrets (trufflehog git)",
      };
    } catch {
      return {
        category: "secrets",
        name: "secrets scan",
        status: "warn",
        detail: "trufflehog scan failed",
        severity: "medium",
      };
    }
  } catch {
    // Trufflehog not installed, use basic pattern matching
    try {
      const { stdout } = await exec(
        "git",
        [
          "grep",
          "-n",
          "-iE",
          "(api[_-]?key|secret[_-]?key|password|token|credential)[\"']?\\s*[:=]\\s*[\"'][^\"']{20,}",
        ],
        { timeout: 10_000 },
      );

      if (stdout.trim()) {
        const lines = stdout.trim().split("\n");
        const matches = lines.length;

        // Extract unique filenames
        const files = new Set<string>();
        for (const line of lines) {
          const match = line.match(/^([^:]+):/);
          if (match) {
            files.add(match[1]);
          }
        }

        const fileArray = Array.from(files);

        return {
          category: "secrets",
          name: "secrets scan",
          status: "warn",
          detail: `${matches} potential secret(s) in ${files.size} file(s)`,
          severity: "high",
          files: fileArray,
          suggestion:
            "Install trufflehog for better detection:\n  • macOS/Linux: brew install trufflehog\n  • Go: go install github.com/trufflesecurity/trufflehog/v3@latest\n  • Or download from: https://github.com/trufflesecurity/trufflehog/releases",
        };
      }
    } catch {
      // No matches or git grep failed
    }

    return {
      category: "secrets",
      name: "secrets scan",
      status: "pass",
      detail:
        "basic scan passed (install trufflehog for better detection: brew install trufflehog)",
    };
  }
}

/**
 * Socket is intentionally NOT part of kit's local-first security check (#103).
 *
 * Socket is a CLOUD service: its supply-chain analysis runs server-side (the v1.x
 * CLI's `socket scan create` UPLOADS your dependency manifest to socket.dev), so it
 * (a) breaks kit's local-first / zero-network promise, and (b) cannot run air-gapped
 * at all — there is no offline/self-host of the analysis engine (Snyk is the same).
 * The legacy `socket check` command kit used was also removed in Socket CLI v1.x.
 *
 * Local supply-chain coverage is provided by bumblebee, osv-scanner, and
 * `kit supply-chain` (#49); a local behavioral/malware-heuristic scanner (GuardDog)
 * is the candidate to fill Socket's niche the local-first way. Run Socket via its
 * own CLI / in CI if you have egress and want its server-side analysis.
 */
async function checkSocket(): Promise<SecurityCheckResult> {
  return {
    category: "supply-chain",
    name: "socket scan",
    status: "skip",
    detail:
      "Socket is cloud-only (uploads manifest; no offline/air-gap) — excluded from kit's local-first check. Local cover: bumblebee + osv-scanner + kit supply-chain",
  };
}

/**
 * GuardDog (DataDog, OSS) — LOCAL behavioral-malware heuristics, the local-first
 * replacement for Socket (#105). OPT-IN (KIT_GUARDDOG=1): GuardDog needs semgrep
 * and `verify` fetches/scans each dependency, so it's too heavy for the default
 * check. Classification (incl. fail-closed on incomplete scans) is in guarddog.ts.
 */
async function checkGuardDog(): Promise<SecurityCheckResult> {
  const base = { category: "supply-chain", name: "guarddog (malware)" } as const;
  const envEnabled = ["1", "true", "yes", "on"].includes(
    (process.env.KIT_GUARDDOG ?? "").trim().toLowerCase(),
  );
  // Persistent project opt-in via `.kit.toml [scan] guarddog = true` (best-effort
  // config read) — so the choice lives in config, not just an ephemeral env var.
  let cfgEnabled = false;
  try {
    const { loadConfig } = await import("./config.js");
    const cfg = await loadConfig(resolve(process.cwd(), ".kit.toml"));
    cfgEnabled = cfg.scan?.guarddog === true;
  } catch {
    // no/invalid config → env var is the only switch
  }
  if (!envEnabled && !cfgEnabled) {
    return {
      ...base,
      status: "skip",
      detail:
        "opt-in — set `guarddog = true` under [scan] in .kit.toml (or KIT_GUARDDOG=1) to run local malware heuristics (needs semgrep)",
    };
  }

  // Pick the ecosystem from the lockfile/manifest present.
  const candidates: { ecosystem: string; file: string }[] = [
    { ecosystem: "npm", file: "package-lock.json" },
    { ecosystem: "npm", file: "package.json" },
    { ecosystem: "pypi", file: "requirements.txt" },
  ];
  let target: { ecosystem: string; file: string } | undefined;
  for (const c of candidates) {
    try {
      await access(resolve(process.cwd(), c.file));
      target = c;
      break;
    } catch {
      // not present — try the next
    }
  }
  if (!target) {
    return { ...base, status: "skip", detail: "no package-lock.json / requirements.txt to scan" };
  }

  const bin = await resolveToolBin("guarddog");
  if (!bin) {
    return {
      ...base,
      status: "warn",
      detail: "guarddog not installed — malware heuristics unavailable",
      severity: "medium",
      suggestion: "mise use pipx:guarddog",
    };
  }

  const result = await execFileNoThrow(
    bin,
    [target.ecosystem, "verify", target.file, "--output-format=json"],
    { timeout: 300_000 },
  );
  return classifyGuardDog(result.stdout || result.stderr);
}

/**
 * Scan Dockerfile and filesystem for CVEs using Trivy.
 * Catches OS-level vulnerabilities that npm audit misses.
 */
async function checkTrivy(): Promise<SecurityCheckResult> {
  const hasDockerfile = await access(resolve(process.cwd(), "Dockerfile"))
    .then(() => true)
    .catch(() => false);
  if (!hasDockerfile) {
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "skip",
      detail: "no Dockerfile found",
    };
  }

  // Resolve mise-first (like socket/semgrep): a mise-installed trivy isn't on kit's PATH.
  const trivyBin = await resolveToolBin("trivy");
  if (!trivyBin) {
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "warn",
      detail: "trivy not installed -container CVEs undetected",
      severity: "medium",
      suggestion: "mise use aqua:aquasecurity/trivy  (or: brew install trivy)",
    };
  }

  const result = await execFileNoThrow(
    trivyBin,
    ["fs", ".", "--format", "json", "--severity", "HIGH,CRITICAL", "--quiet"],
    { timeout: 120_000 },
  );

  if (!result.ok && !result.stdout) {
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "warn",
      detail: "trivy scan failed",
      severity: "medium",
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const vulns: unknown[] = (parsed.Results ?? []).flatMap(
      (r: { Vulnerabilities?: unknown[] }) => r.Vulnerabilities ?? [],
    );

    if (vulns.length === 0) {
      return {
        category: "supply-chain",
        name: "trivy container scan",
        status: "pass",
        detail: "no high/critical container vulnerabilities",
      };
    }
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "fail",
      detail: `${vulns.length} high/critical vulnerability(ies) in container`,
      severity: "high",
    };
  } catch {
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "warn",
      detail: "trivy scan failed",
      severity: "medium",
    };
  }
}

/** Count HIGH/CRITICAL misconfigurations in a `trivy config --format json`
 *  payload. PURE so it can be unit-tested without running trivy. */
export function parseTrivyMisconfigCount(stdout: string): number {
  try {
    const parsed = JSON.parse(stdout) as {
      Results?: { Misconfigurations?: { Severity?: string }[] }[];
    };
    return (parsed.Results ?? [])
      .flatMap((r) => r.Misconfigurations ?? [])
      .filter((m) => m.Severity === "HIGH" || m.Severity === "CRITICAL").length;
  } catch {
    return -1; // unparseable
  }
}

/**
 * IaC misconfiguration scan (Dockerfile / Compose / Terraform) via
 * `trivy config`. Distinct from the container-CVE scan above: that finds
 * vulnerable packages, this finds insecure infrastructure config (root user,
 * privileged containers, public buckets, missing healthchecks, …). Runs only
 * when there is IaC to scan; resolves trivy mise-first like the CVE scan.
 */
async function checkTrivyConfig(): Promise<SecurityCheckResult> {
  const name = "trivy config (IaC)";
  const cwd = process.cwd();
  const fileMarkers = [
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ];
  let hasIaC = false;
  for (const m of fileMarkers) {
    if (
      await access(resolve(cwd, m))
        .then(() => true)
        .catch(() => false)
    ) {
      hasIaC = true;
      break;
    }
  }
  if (!hasIaC) {
    // Any top-level Terraform?
    try {
      const entries = await readdir(cwd);
      hasIaC = entries.some((e) => e.endsWith(".tf"));
    } catch {
      /* unreadable cwd — treat as no IaC */
    }
  }
  if (!hasIaC) {
    return {
      category: "supply-chain",
      name,
      status: "skip",
      detail: "no Dockerfile/Compose/Terraform found",
    };
  }

  const trivyBin = await resolveToolBin("trivy");
  if (!trivyBin) {
    return {
      category: "supply-chain",
      name,
      status: "warn",
      detail: "trivy not installed -IaC misconfigurations undetected",
      severity: "medium",
      suggestion: "mise use aqua:aquasecurity/trivy  (or: brew install trivy)",
    };
  }

  const result = await execFileNoThrow(
    trivyBin,
    ["config", ".", "--format", "json", "--severity", "HIGH,CRITICAL", "--quiet"],
    { timeout: 120_000 },
  );
  const count = parseTrivyMisconfigCount(result.stdout);
  if (count < 0) {
    return {
      category: "supply-chain",
      name,
      status: "warn",
      detail: "trivy config scan failed",
      severity: "medium",
    };
  }
  if (count === 0) {
    return {
      category: "supply-chain",
      name,
      status: "pass",
      detail: "no high/critical IaC misconfigurations",
    };
  }
  return {
    category: "supply-chain",
    name,
    status: "warn",
    detail: `${count} high/critical IaC misconfiguration(s) -run: trivy config .`,
    severity: "high",
  };
}

export type JvmKind = "maven" | "gradle";

/** Classify a directory's filenames as a JVM project root (pure, testable). #110 */
export function jvmProjectKind(files: string[]): JvmKind | null {
  if (files.includes("pom.xml")) return "maven";
  if (files.includes("build.gradle") || files.includes("build.gradle.kts")) return "gradle";
  return null;
}

const JVM_IGNORE = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".kit",
  ".gradle",
  ".next",
]);

/** Locate the nearest JVM project — Maven (`pom.xml`) or Gradle (`build.gradle[.kts]`)
 *  — within `maxDepth` directories of cwd (BFS, shallowest wins), skipping
 *  build/vendor dirs. Returns `{dir, kind}` or null. Depth ≤3 covers monorepo
 *  layouts like `services/backend/pom.xml` that the old depth-1 scan missed (#110). */
export async function findJvmProject(
  cwd: string,
  maxDepth = 3,
): Promise<{ dir: string; kind: JvmKind } | null> {
  let frontier: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }];
  while (frontier.length > 0) {
    const next: { dir: string; depth: number }[] = [];
    for (const { dir, depth } of frontier) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable dir — skip
      }
      const kind = jvmProjectKind(entries.filter((e) => e.isFile()).map((e) => e.name));
      if (kind) return { dir, kind };
      if (depth < maxDepth) {
        for (const e of entries) {
          if (e.isDirectory() && !JVM_IGNORE.has(e.name)) {
            next.push({ dir: resolve(dir, e.name), depth: depth + 1 });
          }
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** Count vulnerabilities in a `trivy fs --format json` payload. PURE so it can
 *  be unit-tested without running trivy. -1 = unparseable. The caller passes
 *  `--severity HIGH,CRITICAL`, so every counted vuln is already high/critical. */
export function parseTrivyVulnCount(stdout: string): number {
  try {
    const parsed = JSON.parse(stdout) as {
      Results?: { Vulnerabilities?: unknown[] }[];
    };
    return (parsed.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []).length;
  } catch {
    return -1;
  }
}

/**
 * Maven/Java dependency CVE scan via `trivy fs --offline-scan`. Fills the gap
 * left by npm audit / pip-audit / osv-scanner, none of which resolve a Maven
 * project's transitive dependency tree.
 *
 * Always OFFLINE: trivy's online Java resolver fetches every transitive POM from
 * Maven Central and trips its anonymous 429 rate-limit on each run, blocking the
 * host for ~30 min. `--offline-scan` reads the transitive tree from the local
 * `~/.m2` cache instead — so the cache must be populated (a real `mvn` build
 * locally, or a CI step that caches `~/.m2`). Without it trivy sees only direct
 * deps and silently under-reports, so we warn rather than pass.
 */
async function checkMavenAudit(): Promise<SecurityCheckResult> {
  const found = await findJvmProject(process.cwd());
  const name = `trivy fs (${found?.kind ?? "jvm"})`;
  if (!found) {
    return {
      category: "dependency",
      name: "trivy fs (jvm)",
      status: "skip",
      detail: "no Maven/Gradle project found",
    };
  }
  const { dir: mavenDir, kind } = found;

  const trivyBin = await resolveToolBin("trivy");
  if (!trivyBin) {
    return {
      category: "dependency",
      name,
      status: "warn",
      detail: "trivy not installed -maven CVEs undetected",
      severity: "medium",
      suggestion: "mise use aqua:aquasecurity/trivy  (or: brew install trivy)",
    };
  }

  // Transitive resolution source: Maven reads ~/.m2; Gradle reads gradle.lockfile.
  // Without it trivy sees only direct deps, so warn (don't pass) — a green check
  // must never hide the transitive gap (#110).
  if (kind === "maven") {
    const m2 = resolve(homedir(), ".m2", "repository");
    const hasM2 = await access(m2)
      .then(() => true)
      .catch(() => false);
    if (!hasM2) {
      return {
        category: "dependency",
        name,
        status: "warn",
        detail: "no ~/.m2 cache -maven transitive CVEs undetected",
        severity: "medium",
        suggestion:
          "populate the Maven cache: mvn dependency:go-offline (cache ~/.m2 in CI), then re-run",
      };
    }
  } else {
    const hasLock = await access(resolve(mavenDir, "gradle.lockfile"))
      .then(() => true)
      .catch(() => false);
    if (!hasLock) {
      return {
        category: "dependency",
        name,
        status: "warn",
        detail: "no gradle.lockfile -gradle transitive CVEs undetected (only direct deps scanned)",
        severity: "medium",
        suggestion:
          "generate a lockfile: gradle dependencies --write-locks (commit gradle.lockfile), then re-run",
      };
    }
  }

  const result = await execFileNoThrow(
    trivyBin,
    [
      "fs",
      mavenDir,
      "--offline-scan",
      "--scanners",
      "vuln",
      "--format",
      "json",
      "--severity",
      "HIGH,CRITICAL",
      "--quiet",
    ],
    { timeout: 180_000 },
  );
  if (!result.ok && !result.stdout) {
    return {
      category: "dependency",
      name,
      status: "warn",
      detail: "trivy JVM scan failed",
      severity: "medium",
    };
  }
  const count = parseTrivyVulnCount(result.stdout);
  if (count < 0) {
    return {
      category: "dependency",
      name,
      status: "warn",
      detail: "trivy JVM scan failed",
      severity: "medium",
    };
  }
  if (count === 0) {
    return {
      category: "dependency",
      name,
      status: "pass",
      detail: "no high/critical JVM dependency CVEs",
    };
  }
  return {
    category: "dependency",
    name,
    status: "fail",
    detail: `${count} high/critical JVM dependency CVE(s) -run: trivy fs --offline-scan ${mavenDir}`,
    severity: "high",
  };
}

/** Count vulnerabilities in an `osv-scanner --format json` payload. PURE so it
 *  can be unit-tested without running osv-scanner. -1 = unparseable. */
export function parseOsvVulnCount(stdout: string): number {
  try {
    const parsed = JSON.parse(stdout) as {
      results?: { packages?: { vulnerabilities?: unknown[] }[] }[];
    };
    return (parsed.results ?? [])
      .flatMap((r) => r.packages ?? [])
      .flatMap((p) => p.vulnerabilities ?? []).length;
  } catch {
    return -1;
  }
}

/**
 * Multi-ecosystem dependency CVE scan via osv-scanner (Google OSV). Provisioned
 * only for ecosystems kit has no dedicated scanner for (go/rust/php/…) — for
 * node it's npm audit, for python pip-audit — so it skips cleanly when absent
 * rather than duplicating those. Resolves mise-first.
 */
async function checkOsvScanner(): Promise<SecurityCheckResult> {
  const name = "osv-scanner (deps)";
  const osvBin = await resolveToolBin("osv-scanner");
  if (!osvBin) {
    return {
      category: "supply-chain",
      name,
      status: "skip",
      detail: "osv-scanner not installed (mise use aqua:google/osv-scanner)",
    };
  }
  const result = await execFileNoThrow(osvBin, ["--format", "json", "-r", "."], {
    timeout: 120_000,
  });
  const count = parseOsvVulnCount(result.stdout);
  if (count < 0) {
    // osv exits non-zero with no JSON when there are no lockfiles to scan.
    return { category: "supply-chain", name, status: "skip", detail: "no lockfiles to scan" };
  }
  if (count === 0) {
    return {
      category: "supply-chain",
      name,
      status: "pass",
      detail: "no known dependency vulnerabilities",
    };
  }
  return {
    category: "supply-chain",
    name,
    status: "warn",
    detail: `${count} known dependency vulnerability(ies) -run: osv-scanner -r .`,
    severity: "high",
  };
}

/**
 * Check dependency licenses for GPL/AGPL that create legal obligations.
 */
async function checkLicenses(): Promise<SecurityCheckResult> {
  try {
    await access(resolve(process.cwd(), "package.json"));
  } catch {
    return {
      category: "supply-chain",
      name: "license check",
      status: "skip",
      detail: "no package.json found",
    };
  }

  // Try direct binary first (fast). If absent, fall back to `npx --yes
  // license-checker` so we don't force users to `npm install -g`.
  // npx first-run can fetch the package, so allow generous timeout.
  let runner: { cmd: string; baseArgs: string[] } | null = null;
  // Resolve mise-first so a `mise use -g` license-checker is found even when mise
  // isn't activated; otherwise fall back to npx (below).
  const licenseCheckerBin = (await resolveToolBin("license-checker")) ?? "license-checker";
  const direct = await execFileNoThrow(licenseCheckerBin, ["--version"], { timeout: 5_000 });
  if (direct.ok) {
    runner = { cmd: licenseCheckerBin, baseArgs: [] };
  } else {
    const npxAvailable = await execFileNoThrow("npx", ["--version"], { timeout: 5_000 });
    if (npxAvailable.ok) {
      runner = { cmd: "npx", baseArgs: ["--yes", "license-checker"] };
    }
  }

  if (!runner) {
    return {
      category: "supply-chain",
      name: "license check",
      status: "warn",
      detail: "license-checker not installed (npx also unavailable)",
      severity: "low",
      suggestion: "npm install -g license-checker",
    };
  }

  const PROBLEMATIC = ["GPL", "AGPL", "LGPL", "CPAL", "OSL", "EUPL"];
  const result = await execFileNoThrow(runner.cmd, [...runner.baseArgs, "--json", "--production"], {
    timeout: 120_000,
  });

  if (!result.ok && !result.stdout) {
    return {
      category: "supply-chain",
      name: "license check",
      status: "warn",
      detail: "license check failed",
      severity: "low",
    };
  }

  try {
    const packages = JSON.parse(result.stdout) as Record<string, { licenses?: string }>;
    const violations: string[] = [];

    for (const [pkg, info] of Object.entries(packages)) {
      const license = info.licenses ?? "";
      if (PROBLEMATIC.some((l) => license.toUpperCase().includes(l))) {
        violations.push(`${pkg} (${license})`);
      }
    }

    if (violations.length > 0) {
      return {
        category: "supply-chain",
        name: "license check",
        status: "warn",
        detail: `${violations.length} copyleft license(s): ${violations.slice(0, 3).join(", ")}${violations.length > 3 ? ` +${violations.length - 3} more` : ""}`,
        severity: "medium",
      };
    }
    return {
      category: "supply-chain",
      name: "license check",
      status: "pass",
      detail: "no problematic licenses found",
    };
  } catch {
    return {
      category: "supply-chain",
      name: "license check",
      status: "warn",
      detail: "license check failed",
      severity: "low",
    };
  }
}

/**
 * Run static analysis using Semgrep to catch security anti-patterns in source code.
 */
async function checkSemgrep(): Promise<SecurityCheckResult> {
  // Resolve mise-first (see socket): a mise-installed semgrep isn't on kit's PATH.
  const semgrepBin = await resolveToolBin("semgrep");
  if (!semgrepBin) {
    return {
      category: "supply-chain",
      name: "semgrep SAST",
      status: "skip",
      detail: "semgrep not installed (mise use pipx:semgrep, or brew install semgrep)",
    };
  }

  // Opt-in: a networked, multi-second SAST scan does not run by default. Enable
  // it by setting KIT_SEMGREP_CONFIG to a ruleset (e.g. p/default, or a local
  // ruleset path for air-gap). Skipping is honest — green stays "0 unreviewed".
  if (!process.env.KIT_SEMGREP_CONFIG?.trim()) {
    return {
      category: "supply-chain",
      name: "semgrep SAST",
      status: "skip",
      detail:
        "SAST opt-in: set KIT_SEMGREP_CONFIG (e.g. p/default, or a local ruleset path) to enable",
    };
  }

  const semgrepCfg = semgrepConfig(process.env);
  const result = await execFileNoThrow(
    semgrepBin,
    buildSemgrepArgs({ mode: "json", config: semgrepCfg }),
    { timeout: 120_000 },
  );

  const raw = result.stdout || result.stderr;
  try {
    const parsed = JSON.parse(raw);
    const findings: Array<{ extra?: { severity?: string } }> = parsed.results ?? [];
    const high = findings.filter(
      (f) => f.extra?.severity === "ERROR" || f.extra?.severity === "WARNING",
    );

    if (high.length === 0) {
      return {
        category: "supply-chain",
        name: "semgrep SAST",
        status: "pass",
        detail: "no security issues found",
      };
    }
    return {
      category: "supply-chain",
      name: "semgrep SAST",
      status: high.some((f) => f.extra?.severity === "ERROR") ? "fail" : "warn",
      detail: `${high.length} security finding(s) -run: semgrep scan --config ${semgrepCfg}`,
      severity: high.some((f) => f.extra?.severity === "ERROR") ? "high" : "medium",
    };
  } catch {
    return {
      category: "supply-chain",
      name: "semgrep SAST",
      status: "warn",
      detail: "semgrep scan failed",
      severity: "low",
    };
  }
}

/**
 * Scan for installed packages matching known supply-chain compromise catalogs
 * using bumblebee. Unlike npm/pip audit (known CVEs), this flags packages that
 * exactly match curated incident catalogs (shai-hulud, typosquats, credential
 * stealers, malicious editor/browser extensions, etc.).
 *
 * Zero-config by default; tunable via environment:
 *   KIT_BUMBLEBEE        set to 0/false to skip the check entirely
 *   KIT_NO_DOWNLOAD      set to 1 to never fetch the scanner binary
 *   KIT_BUMBLEBEE_PROFILE  baseline (default) | project | deep
 *   KIT_BUMBLEBEE_ROOTS    comma-separated roots (e.g. "." for the repo; required for deep)
 *   KIT_BUMBLEBEE_BIN      use a pre-installed bumblebee instead of downloading
 *   KIT_BUMBLEBEE_CATALOG  override the exposure-catalog directory
 */
async function checkBumblebee(): Promise<SecurityCheckResult> {
  const name = "bumblebee (supply-chain)";
  const category = "supply-chain" as const;

  // Publish gate: when set, an UNSCANNED release must not ship. Scanner-
  // unavailable / scan-failed / scan-incomplete are "warn" (advisory) in normal
  // runs but become a hard "fail" here so the gate can fail-closed (#supply).
  const required = envFlagEnabled(process.env.KIT_BUMBLEBEE_REQUIRED);
  // "could not scan" status under the required gate: fail-closed instead of warn.
  const unscanned = required ? ("fail" as const) : ("warn" as const);

  if (envFlagDisabled(process.env.KIT_BUMBLEBEE)) {
    return { category, name, status: "skip", detail: "disabled via KIT_BUMBLEBEE" };
  }

  const { install, reason, kind } = await ensureBumblebee({
    allowDownload: !envFlagEnabled(process.env.KIT_NO_DOWNLOAD),
  });
  if (!install) {
    // A failed integrity check (checksum mismatch) is a potential tampering
    // event — escalate to a hard failure rather than failing open to a warn.
    if (kind === "integrity") {
      return {
        category,
        name,
        status: "fail",
        detail: `scanner ${reason}`,
        severity: "high",
        suggestion:
          "The downloaded scanner did not match its pinned checksum. Do NOT trust it. Investigate for tampering (network MITM, compromised mirror), clear ~/.kit/tools/bumblebee, and retry from a trusted network.",
      };
    }
    return {
      category,
      name,
      status: unscanned,
      detail: `scanner unavailable: ${reason}${required ? " (KIT_BUMBLEBEE_REQUIRED — cannot ship unscanned)" : ""}`,
      severity: required ? "high" : "low",
      suggestion:
        "Provide a binary with KIT_BUMBLEBEE_BIN, or allow downloads (unset KIT_NO_DOWNLOAD). Manual install: go install github.com/perplexityai/bumblebee/cmd/bumblebee@latest",
    };
  }

  const profile = process.env.KIT_BUMBLEBEE_PROFILE || "baseline";
  const roots = (process.env.KIT_BUMBLEBEE_ROOTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { outcome, error } = await runScan({ install, profile, roots });
  if (error || !outcome) {
    return {
      category,
      name,
      status: unscanned,
      detail: `scan failed: ${error ?? "no output"}${required ? " (KIT_BUMBLEBEE_REQUIRED — cannot ship unscanned)" : ""}`,
      severity: required ? "high" : "medium",
    };
  }

  if (outcome.findings.length > 0) {
    const catalogs = describeFindings(outcome.findings);
    // F9: persist every catalog match to the local audit log so the find
    // survives the next CI run and shows up in `kit audit`.
    await logSupplyChainFindings(outcome.findings, profile).catch(() => {});
    return {
      category,
      name,
      status: "fail",
      detail: `${outcome.findings.length} known supply-chain exposure(s): ${catalogs}`,
      severity: toResultSeverity(maxSeverity(outcome.findings)),
      files: Array.from(new Set(outcome.findings.map((f) => f.sourceFile).filter(Boolean))),
      suggestion:
        "Remove or downgrade the flagged packages immediately — they match curated known-compromise catalogs. Verify on the source advisory before trusting any replacement.",
    };
  }

  if (!outcome.summarySeen || outcome.status !== "complete" || outcome.timedOut) {
    return {
      category,
      name,
      status: unscanned,
      detail: `scan incomplete (status=${outcome.status}${outcome.timedOut ? ", timed out" : ""})${required ? " (KIT_BUMBLEBEE_REQUIRED — cannot ship unscanned)" : ""}`,
      severity: required ? "high" : "low",
    };
  }

  // Clean scan — but a frozen catalog set silently loses coverage over time.
  const newest = await newestCatalogMtime(install.catalogDir);
  if (newest !== null) {
    const { stale, ageDays } = isCatalogStale(newest, Date.now());
    if (stale) {
      return {
        category,
        name,
        status: "warn",
        severity: "low",
        detail: `no known exposures (${outcome.packagesScanned} packages), but threat-intel catalogs are ${ageDays} days old`,
        suggestion:
          "Bump BUMBLEBEE_VERSION (and TARBALL_CHECKSUMS) in src/bumblebee.ts to refresh the exposure catalogs.",
      };
    }
  }

  return {
    category,
    name,
    status: "pass",
    detail: `no known exposures (${outcome.packagesScanned} packages, profile=${profile})`,
  };
}

/** Short, human-readable summary of the catalogs matched by findings. */
function describeFindings(findings: BumblebeeFinding[]): string {
  const labels = Array.from(
    new Set(findings.map((f) => f.catalogName || f.catalogId).filter(Boolean)),
  );
  const shown = labels.slice(0, 3).join("; ");
  return labels.length > 3 ? `${shown}; +${labels.length - 3} more` : shown;
}

/**
 * Run all security checks
 */
export async function checkSecurity(): Promise<SecurityCheckResult[]> {
  const results: SecurityCheckResult[] = [];

  const [
    npmResult,
    pipResult,
    envResult,
    pinnedResult,
    secretsScan,
    socketResult,
    trivyResult,
    licenseResult,
    semgrepResult,
    bumblebeeResult,
    trivyConfigResult,
    osvResult,
    mavenResult,
    guarddogResult,
    ...lockfileResults
  ] = await Promise.all([
    checkNpmAudit(),
    checkPipAudit(),
    checkEnvGitignored(),
    checkPinnedVersions(),
    checkSecretsInCode(),
    checkSocket(),
    checkTrivy(),
    checkLicenses(),
    checkSemgrep(),
    checkBumblebee(),
    checkTrivyConfig(),
    checkOsvScanner(),
    checkMavenAudit(),
    checkGuardDog(),
    ...(await checkLockfilesCommitted()),
  ]);

  results.push(
    npmResult,
    pipResult,
    envResult,
    pinnedResult,
    secretsScan,
    socketResult,
    trivyResult,
    licenseResult,
    semgrepResult,
    bumblebeeResult,
    trivyConfigResult,
    osvResult,
    mavenResult,
    guarddogResult,
  );
  results.push(...lockfileResults);

  const exposureResults = await checkServiceExposure();
  results.push(...exposureResults);

  // At-rest exposure of kit's own secret-dense local state: verify full-disk
  // encryption is on, and that the memory store isn't redirected into a repo.
  const { checkDiskEncryption, checkMemoryDirSafety } = await import("./check-disk-encryption.js");
  results.push(await checkDiskEncryption());
  results.push(checkMemoryDirSafety());

  // Attach a rule citation (CWE/OWASP) to each finding whose check is mapped in
  // the local rules catalog. Deterministic lookup, no network. Unmapped checks
  // pass through unchanged.
  return results.map((r) => {
    const rule = ruleForCheck(r.name);
    return rule ? { ...r, rule } : r;
  });
}

/** Separate findings sink — deliberately NOT the chained audit log. */
export const SUPPLY_CHAIN_FINDINGS_FILE = ".kit-findings.jsonl";

/** Build the JSONL lines for a batch of supply-chain findings. PURE/testable. */
export function buildSupplyChainFindingLines(
  findings: BumblebeeFinding[],
  profile: string,
  now: Date = new Date(),
): string {
  return findings
    .map((f) =>
      JSON.stringify({
        timestamp: now.toISOString(),
        event_type: "supply_chain_finding",
        source: "bumblebee",
        profile,
        catalog_id: f.catalogId,
        catalog_name: f.catalogName,
        severity: f.severity,
        package: f.packageName || "unknown",
        version: f.version || null,
        ecosystem: f.ecosystem || null,
        source_file: f.sourceFile || null,
        evidence: f.evidence || null,
      }),
    )
    .join("\n");
}

/**
 * F9 — append bumblebee supply-chain findings to a SEPARATE local JSONL sink
 * (`.kit-findings.jsonl`), NOT the chained `.kit-audit.jsonl`. These are raw,
 * unchained lines; appending them to the tamper-evident audit log would break
 * its hash chain and make `kit audit verify` falsely report BROKEN. Bypasses
 * governance config so the trail is captured even without `.kit.toml`.
 */
async function logSupplyChainFindings(
  findings: BumblebeeFinding[],
  profile: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  const path = resolve(cwd, SUPPLY_CHAIN_FINDINGS_FILE);
  const lines = buildSupplyChainFindingLines(findings, profile);
  if (lines) {
    await appendFile(path, lines + "\n", "utf-8");
  }
}
