import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
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
function toResultSeverity(
  label: string | null,
): SecurityCheckResult["severity"] {
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
  category: "dependency" | "exposure" | "supply-chain" | "secrets";
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
    await exec("npm", ["audit", "--audit-level=high", "--json"], {
      timeout: 30_000,
    });
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

  try {
    // Check if pip-audit is installed
    await exec("pip-audit", ["--version"], { timeout: 5_000 });
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
    const { stdout } = await exec("pip-audit", ["--format=json"], {
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
      v.vulnerabilities?.some(vuln => vuln.severity === "high" || vuln.severity === "critical")
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
    const gitignoreContent = await readFile(
      resolve(process.cwd(), ".gitignore"),
      "utf-8"
    );
    
    const envPatterns = [".env", ".env.local", ".env.*.local"];
    const missingPatterns = envPatterns.filter(
      pattern => !gitignoreContent.includes(pattern)
    );
    
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
      { timeout: 5_000 }
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
          ["-c", "ss -tlnp 2>/dev/null | grep :11434 || netstat -tlnp 2>/dev/null | grep :11434 || echo 'no listener'"],
          { timeout: 5_000 }
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
      ["-c", "ss -tlnp 2>/dev/null | grep :3199 || netstat -tlnp 2>/dev/null | grep :3199 || echo 'no listener'"],
      { timeout: 5_000 }
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
    const packageJsonContent = await readFile(
      resolve(process.cwd(), "package.json"),
      "utf-8"
    );
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
    const requirementsContent = await readFile(
      resolve(process.cwd(), "requirements.txt"),
      "utf-8"
    );
    
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
  
  // Try trufflehog first
  try {
    await exec("trufflehog", ["--version"], { timeout: 5_000 });
    
    try {
      const { stdout } = await exec(
        "trufflehog",
        ["filesystem", ".", "--json", "--no-update"],
        { timeout: 60_000 }
      );
      
      const findings = stdout.trim().split("\n").filter(Boolean);
      
      if (findings.length > 0) {
        return {
          category: "secrets",
          name: "secrets scan",
          status: "fail",
          detail: `${findings.length} potential secret(s) found`,
          severity: "critical",
        };
      }
      
      return {
        category: "secrets",
        name: "secrets scan",
        status: "pass",
        detail: "no secrets detected (trufflehog)",
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
        { timeout: 10_000 }
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
          suggestion: "Install trufflehog for better detection:\n  • macOS/Linux: brew install trufflehog\n  • Go: go install github.com/trufflesecurity/trufflehog/v3@latest\n  • Or download from: https://github.com/trufflesecurity/trufflehog/releases",
        };
      }
    } catch {
      // No matches or git grep failed
    }
    
    return {
      category: "secrets",
      name: "secrets scan",
      status: "pass",
      detail: "basic scan passed (install trufflehog for better detection: brew install trufflehog)",
    };
  }
}

/**
 * Check for supply chain attacks using Socket CLI.
 * Detects behavioral anomalies (obfuscated files, unexpected network calls, install scripts)
 * that npm audit misses -catches intentional malware like node-ipc and compromised packages.
 */
async function checkSocket(): Promise<SecurityCheckResult> {
  try {
    await access(resolve(process.cwd(), "package.json"));
  } catch {
    return { category: "supply-chain", name: "socket scan", status: "skip", detail: "no package.json found" };
  }

  const versionCheck = await execFileNoThrow("socket", ["--version"], { timeout: 5_000 });
  if (!versionCheck.ok) {
    return {
      category: "supply-chain",
      name: "socket scan",
      status: "warn",
      detail: "socket not installed -supply chain malware undetected",
      severity: "medium",
      suggestion: "npm install -g @socketsecurity/cli",
    };
  }

  const result = await execFileNoThrow("socket", ["check", "--json"], { timeout: 60_000 });
  const raw = result.stdout || result.stderr;

  try {
    const parsed = JSON.parse(raw);
    const issues: Array<{ severity?: string }> = parsed.issues ?? parsed.alerts ?? [];
    const critical = issues.filter((i) => i.severity === "critical" || i.severity === "high");

    if (critical.length > 0) {
      return {
        category: "supply-chain",
        name: "socket scan",
        status: "fail",
        detail: `${critical.length} critical/high supply chain issue(s) -run: socket check`,
        severity: "critical",
      };
    }
    if (issues.length > 0) {
      return {
        category: "supply-chain",
        name: "socket scan",
        status: "warn",
        detail: `${issues.length} supply chain warning(s) -run: socket check`,
        severity: "medium",
      };
    }
  } catch {
    // Non-JSON output: socket check passed (exit 0, human-readable)
  }

  if (!result.ok) {
    return {
      category: "supply-chain",
      name: "socket scan",
      status: "warn",
      detail: "socket check failed -verify installation or run: socket login",
      severity: "medium",
      suggestion: "socket login",
    };
  }

  return { category: "supply-chain", name: "socket scan", status: "pass", detail: "no supply chain issues detected" };
}

/**
 * Scan Dockerfile and filesystem for CVEs using Trivy.
 * Catches OS-level vulnerabilities that npm audit misses.
 */
async function checkTrivy(): Promise<SecurityCheckResult> {
  const hasDockerfile = await access(resolve(process.cwd(), "Dockerfile")).then(() => true).catch(() => false);
  if (!hasDockerfile) {
    return { category: "supply-chain", name: "trivy container scan", status: "skip", detail: "no Dockerfile found" };
  }

  const versionCheck = await execFileNoThrow("trivy", ["--version"], { timeout: 5_000 });
  if (!versionCheck.ok) {
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "warn",
      detail: "trivy not installed -container CVEs undetected",
      severity: "medium",
      suggestion: "brew install trivy",
    };
  }

  const result = await execFileNoThrow(
    "trivy",
    ["fs", ".", "--format", "json", "--severity", "HIGH,CRITICAL", "--quiet"],
    { timeout: 120_000 },
  );

  if (!result.ok && !result.stdout) {
    return { category: "supply-chain", name: "trivy container scan", status: "warn", detail: "trivy scan failed", severity: "medium" };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const vulns: unknown[] = (parsed.Results ?? []).flatMap(
      (r: { Vulnerabilities?: unknown[] }) => r.Vulnerabilities ?? [],
    );

    if (vulns.length === 0) {
      return { category: "supply-chain", name: "trivy container scan", status: "pass", detail: "no high/critical container vulnerabilities" };
    }
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "fail",
      detail: `${vulns.length} high/critical vulnerability(ies) in container`,
      severity: "high",
    };
  } catch {
    return { category: "supply-chain", name: "trivy container scan", status: "warn", detail: "trivy scan failed", severity: "medium" };
  }
}

/**
 * Check dependency licenses for GPL/AGPL that create legal obligations.
 */
async function checkLicenses(): Promise<SecurityCheckResult> {
  try {
    await access(resolve(process.cwd(), "package.json"));
  } catch {
    return { category: "supply-chain", name: "license check", status: "skip", detail: "no package.json found" };
  }

  // Try direct binary first (fast). If absent, fall back to `npx --yes
  // license-checker` so we don't force users to `npm install -g`.
  // npx first-run can fetch the package, so allow generous timeout.
  let runner: { cmd: string; baseArgs: string[] } | null = null;
  const direct = await execFileNoThrow("license-checker", ["--version"], { timeout: 5_000 });
  if (direct.ok) {
    runner = { cmd: "license-checker", baseArgs: [] };
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
  const result = await execFileNoThrow(
    runner.cmd,
    [...runner.baseArgs, "--json", "--production"],
    { timeout: 120_000 },
  );

  if (!result.ok && !result.stdout) {
    return { category: "supply-chain", name: "license check", status: "warn", detail: "license check failed", severity: "low" };
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
    return { category: "supply-chain", name: "license check", status: "pass", detail: "no problematic licenses found" };
  } catch {
    return { category: "supply-chain", name: "license check", status: "warn", detail: "license check failed", severity: "low" };
  }
}

/**
 * Run static analysis using Semgrep to catch security anti-patterns in source code.
 */
async function checkSemgrep(): Promise<SecurityCheckResult> {
  const versionCheck = await execFileNoThrow("semgrep", ["--version"], { timeout: 5_000 });
  if (!versionCheck.ok) {
    return {
      category: "supply-chain",
      name: "semgrep SAST",
      status: "skip",
      detail: "semgrep not installed (brew install semgrep)",
    };
  }

  const result = await execFileNoThrow(
    "semgrep",
    ["scan", "--config", "auto", "--json", "--quiet", "--no-rewrite-rule-ids"],
    { timeout: 120_000 },
  );

  const raw = result.stdout || result.stderr;
  try {
    const parsed = JSON.parse(raw);
    const findings: Array<{ extra?: { severity?: string } }> = parsed.results ?? [];
    const high = findings.filter((f) => f.extra?.severity === "ERROR" || f.extra?.severity === "WARNING");

    if (high.length === 0) {
      return { category: "supply-chain", name: "semgrep SAST", status: "pass", detail: "no security issues found" };
    }
    return {
      category: "supply-chain",
      name: "semgrep SAST",
      status: high.some((f) => f.extra?.severity === "ERROR") ? "fail" : "warn",
      detail: `${high.length} security finding(s) -run: semgrep scan --config auto`,
      severity: high.some((f) => f.extra?.severity === "ERROR") ? "high" : "medium",
    };
  } catch {
    return { category: "supply-chain", name: "semgrep SAST", status: "warn", detail: "semgrep scan failed", severity: "low" };
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
      status: "warn",
      detail: `scanner unavailable: ${reason}`,
      severity: "low",
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
      status: "warn",
      detail: `scan failed: ${error ?? "no output"}`,
      severity: "medium",
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
      status: "warn",
      detail: `scan incomplete (status=${outcome.status}${outcome.timedOut ? ", timed out" : ""})`,
      severity: "low",
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
    ...await checkLockfilesCommitted(),
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
  );
  results.push(...lockfileResults);

  const exposureResults = await checkServiceExposure();
  results.push(...exposureResults);

  // Attach a rule citation (CWE/OWASP) to each finding whose check is mapped in
  // the local rules catalog. Deterministic lookup, no network. Unmapped checks
  // pass through unchanged.
  return results.map((r) => {
    const rule = ruleForCheck(r.name);
    return rule ? { ...r, rule } : r;
  });
}

/**
 * F9 — append bumblebee supply-chain findings to the local audit JSONL.
 * Bypasses the governance config so the trail is captured even when
 * `kit check` is run without `.kit.toml`. One JSON line per finding.
 */
async function logSupplyChainFindings(
  findings: BumblebeeFinding[],
  profile: string,
): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  const path = resolve(process.cwd(), ".kit-audit.jsonl");
  const lines = findings
    .map((f) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
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
  if (lines) {
    await appendFile(path, lines + "\n", "utf-8");
  }
}
