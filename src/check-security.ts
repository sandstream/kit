import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { resolveWorkspaceRoots } from "./workspaces.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { classifyGuardDog } from "./guarddog.js";
import { depsHashFor, loadGuardDogCache, saveGuardDogCache } from "./guarddog-cache.js";
import { buildSemgrepArgs, semgrepConfig, isAirGap, isLocalSemgrepConfig } from "./scanners.js";
import { ruleForCheck, type RuleRef } from "./rules/catalog.js";
import { TRIAGE_MAX_AGE_DAYS } from "./commands/triage.js";
import {
  ensureBumblebee,
  runScan,
  maxSeverity,
  newestCatalogMtime,
  isCatalogStale,
  BUMBLEBEE_VERSION,
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
  /**
   * True when the check could NOT actually run (tool/binary absent, token missing,
   * scan crashed/timed out) — as opposed to running and finding an issue. The CI
   * gate fails these BY DEFAULT (scanner-health strict: green means every check
   * actually ran); `--lenient` / KIT_CI_LENIENT downgrades them back to a warning.
   * A legitimate not-applicable skip (no manifest, opt-in not enabled) is NOT
   * didNotRun — it is an honest skip.
   */
  didNotRun?: boolean;
  /**
   * An out-of-verdict advisory riding on this result. Some signals must NOT move
   * pass/fail — catalog age is a function of the wall clock, an upstream release is a
   * function of someone else's schedule — but they still need to reach a human. A
   * printed line scrolls out of the terminal; this carries the signal to the PAL
   * ledger (persistent, cross-session, counted in the statusline) without any
   * consumer having to string-match the `detail` text. `key` is the stable dedup
   * identity, so the ledger row auto-closes once the advisory stops being emitted.
   */
  advisory?: { key: string; title: string; detail: string };
  /**
   * The self-audit rule id (e.g. "R2-secret-argv") that produced this result.
   * Lets consumers (kit coverage --verify) bind evidence by the stable rule id
   * instead of the human-facing result name. Only set on self-audit results.
   */
  ruleId?: string;
}

export interface GateOpts {
  /** Downgrade a didNotRun result back to a warning (pre-3.3 behavior). */
  lenient?: boolean;
  /** Fail on ANY warning, including findings the check actually produced. */
  failOnWarning?: boolean;
}

/**
 * The effective gate status for a security result under kit's scanner-health-STRICT
 * default: a check that could not RUN (`didNotRun`) FAILS unless `lenient`; a
 * finding-level warning (the check ran and flagged something) stays a warning unless
 * `failOnWarning`. pass/skip/fail pass through. Single source of truth so `kit check`
 * and `kit ci` gate identically. Pure + deterministic.
 */
export function gateStatus(
  r: SecurityCheckResult,
  opts: GateOpts = {},
): SecurityCheckResult["status"] {
  if (r.status !== "warn") return r.status;
  if (r.didNotRun && !opts.lenient) return "fail";
  if (opts.failOnWarning) return "fail";
  return "warn";
}

/**
 * A KIT_DEVICE_ID override is trust-bearing: the device fences in `palList` /
 * `palSyncFindings` auto-close another device's open findings by this id, so a
 * spoofed value could silently close them. deviceId() only validates the format —
 * this surfaces the posture. WARNs (never fails by default) when the override is
 * active AND a real store exists (a device fence is actually in effect); skips
 * otherwise. Escalates under `--fail-on-warning`.
 */
export async function checkDeviceIdOverride(): Promise<SecurityCheckResult> {
  const name = "device-id override";
  const category = "secrets" as const;
  const { deviceIdOverrideActive } = await import("./memory/pal.js");
  if (!deviceIdOverrideActive()) {
    return { category, name, status: "skip", detail: "no KIT_DEVICE_ID override" };
  }
  const { existsSync } = await import("node:fs");
  const { getMemoryDbPath } = await import("./memory/db.js");
  if (!existsSync(getMemoryDbPath())) {
    return {
      category,
      name,
      status: "skip",
      detail: "KIT_DEVICE_ID set but no store — no device fence in effect",
    };
  }
  return {
    category,
    name,
    status: "warn",
    severity: "low",
    detail:
      "KIT_DEVICE_ID override is active — device-fenced auto-close of PAL/security findings trusts this value; unset it unless this device intentionally uses a fixed id",
  };
}

/**
 * R5 — the self-playing loop (memory capture + statusline) depends on hooks in
 * Claude Code / Codex lifecycle config. If they were installed here (durable marker
 * present) but have since VANISHED, capture is silently OFF — the store looks
 * installed but records nothing, a false green. `kit doctor` already flags this; this
 * folds the same liveness into the `kit check` security gate. Skips when never
 * installed (CI / fresh machine) and after a clean `kit memory uninstall` (which
 * clears the marker), so it fails ONLY on genuine silent degradation.
 */
export async function checkMemoryHooksLiveness(): Promise<SecurityCheckResult> {
  const name = "memory hooks liveness";
  const category = "secrets" as const;
  const { allMemoryHooksLiveness } = await import("./memory/install.js");
  const live = allMemoryHooksLiveness();
  if (!live.everInstalled) {
    return { category, name, status: "skip", detail: "memory hooks not installed here" };
  }
  if (live.missing.length === 0) {
    return {
      category,
      name,
      status: "pass",
      detail: `${live.present.length} capture hook(s) wired`,
    };
  }
  return {
    category,
    name,
    status: "fail",
    severity: "high",
    detail: `memory capture is silently OFF — installed here but missing from lifecycle config: ${live.missing.join(", ")}. Run: kit memory install`,
  };
}

/**
 * Git-hook floor — WHERE it is and whether it can fail.
 *
 * README calls git hooks the agent-agnostic enforcement floor, and nothing reported on them:
 * `kit check` had a row for memory hooks and for the PreToolUse gates, none for these. Two
 * measured states were therefore invisible (#496, #497): a floor resolved OUTSIDE the repo
 * through an absolute `core.hooksPath` (deleting that unrelated directory removed the gate,
 * exit 0, no warning), and `context-check` installed with no `[context]` block, which passes
 * every push. Skips when the repo has no kit-managed hooks — kit does not claim a floor nobody
 * asked for.
 */
export async function checkGitHookFloor(cwd?: string): Promise<SecurityCheckResult> {
  const name = "git hook floor";
  const category = "exposure" as const;
  const root = cwd ?? process.cwd();
  const { describeHookFloor, judgeHookFloor } = await import("./hook-floor.js");
  let config;
  try {
    const { loadConfig } = await import("./config.js");
    const { resolve } = await import("node:path");
    config = await loadConfig(resolve(root, ".kit.toml"));
  } catch {
    config = undefined;
  }
  const verdict = judgeHookFloor(describeHookFloor(root, config));
  // The wrapper is the other half of the same floor: the hooks resolve through it, so a hook
  // directory full of correct hooks says nothing if the wrapper's entrypoint is gone (#509).
  const { describeWrapper, judgeWrapper } = await import("./hook-floor.js");
  const wrapper = judgeWrapper(describeWrapper());
  if (wrapper.status === "fail" || (wrapper.status === "warn" && verdict.status === "pass")) {
    return wrapper.severity
      ? {
          category,
          name: "git hook floor",
          status: wrapper.status,
          severity: wrapper.severity,
          detail: wrapper.detail,
        }
      : { category, name: "git hook floor", status: wrapper.status, detail: wrapper.detail };
  }
  return verdict.severity
    ? { category, name, status: verdict.status, severity: verdict.severity, detail: verdict.detail }
    : { category, name, status: verdict.status, detail: verdict.detail };
}

/**
 * Gate liveness — the enforcement floor must prove it exists. If kit installed the
 * PreToolUse gates on THIS machine (machine-local marker present) but a gate has
 * since vanished from `.claude/settings.json`, the agent runs UN-gated while kit
 * still reports green. That is the worst false green: the floor an agent never
 * touches because it isn't there. Keys off the machine-local install marker — NOT
 * the committed CLAUDE.md block, which travels to every clone/CI where the gitignored
 * `.claude/settings.json` legitimately doesn't exist. Skips where gates were never
 * installed (fresh checkout / CI / un-adopted); fails on a machine that lost a gate.
 */
export async function checkGateLiveness(cwd?: string): Promise<SecurityCheckResult> {
  const name = "enforcement gate liveness";
  const category = "exposure" as const;
  const { gateLiveness } = await import("./agent-config.js");
  const live = gateLiveness(cwd);
  const missing: string[] = [];
  if (!live.installGate) missing.push("install-gate (gate-bash)");
  if (!live.envGate) missing.push("env-write-gate (gate-env)");
  if (live.problems.length > 0) {
    return {
      category,
      name,
      status: "fail",
      severity: "high",
      detail: `PreToolUse gate command cannot reliably start — ${live.problems.join("; ")}`,
    };
  }
  if (!live.everInstalled) {
    return {
      category,
      name,
      status: "skip",
      detail: "enforcement gates not installed on this machine",
    };
  }
  if (missing.length === 0) {
    return { category, name, status: "pass", detail: "PreToolUse enforcement gates wired" };
  }
  return {
    category,
    name,
    status: "fail",
    severity: "high",
    detail: `enforcement floor has a hole — taught kit here but PreToolUse gate(s) missing from .claude/settings.json: ${missing.join(", ")}. The agent runs un-gated. Run: kit agent-config`,
  };
}

/**
 * R3 — a poisoned memory store is a delayed prompt-injection: stored text is replayed
 * into every session via recall. Quarantined rows are excluded from recall (mitigated),
 * so this flags `kit check` only when a NON-quarantined message still carries a
 * high-confidence injection (e.g. indexed before the insert-time quarantine gate).
 *
 * It WARNS (not hard-fail) because the scanner cannot tell "a message DISCUSSING an
 * injection" from "a poisoned message" — a hard fail would turn every security
 * researcher's gate permanently red. The warn names the one-command remediation
 * (`kit memory scan --injection --quarantine`, which excludes the rows from recall so
 * the warn clears), and it ESCALATES to a fail under `--fail-on-warning` / strict CI.
 * If the store can't be opened/scanned that is a scanner-health failure (`didNotRun`,
 * fails strict by default) — never a silent pass. No store → honest skip.
 */
export async function checkMemoryInjection(): Promise<SecurityCheckResult> {
  const name = "memory injection";
  const category = "secrets" as const;
  const { existsSync } = await import("node:fs");
  const { getMemoryDbPath, openMemoryDbReadOnly } = await import("./memory/db.js");
  const path = getMemoryDbPath();
  if (!existsSync(path)) {
    return { category, name, status: "skip", detail: "no memory store to scan" };
  }
  let db: import("node:sqlite").DatabaseSync;
  try {
    db = openMemoryDbReadOnly(path);
  } catch (e) {
    return {
      category,
      name,
      status: "warn",
      severity: "high",
      didNotRun: true,
      detail: `could not read memory store to scan for injection: ${(e as Error).message}`,
    };
  }
  try {
    const { replayableInjectionCount } = await import("./memory/scan.js");
    const { count, sample, scanned } = replayableInjectionCount(db);
    if (scanned === 0) {
      // Empty store ≡ absent store — nothing recallable to scan. Reporting `skip`
      // here (not `pass`) keeps `kit check` deterministic: the first run materializes
      // an empty memory.db as a side effect, and without this the second run would
      // flip this check skip→pass on identical input.
      return { category, name, status: "skip", detail: "memory store empty — nothing to scan" };
    }
    if (count > 0) {
      return {
        category,
        name,
        status: "warn",
        severity: "high",
        detail: `${count} non-quarantined high-confidence injection(s) recallable from the memory store (${sample}) — run \`kit memory scan --injection --quarantine\` (fails under --fail-on-warning)`,
      };
    }
    return { category, name, status: "pass", detail: "no replayable injection in memory recall" };
  } catch (e) {
    return {
      category,
      name,
      status: "warn",
      severity: "high",
      didNotRun: true,
      detail: `memory injection scan failed: ${(e as Error).message}`,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort close */
    }
  }
}

/**
 * Run npm audit and check for high/critical vulnerabilities
 */
async function checkNpmAudit(root: string): Promise<SecurityCheckResult> {
  try {
    // Check if package.json exists
    await access(resolve(root, "package.json"));
  } catch {
    return {
      category: "dependency",
      name: "npm audit",
      status: "skip",
      detail: "no package.json found",
    };
  }

  // npm audit REQUIRES an npm lockfile. On a pnpm/yarn/bun repo it errors out,
  // which previously surfaced as a high-severity FAIL on a perfectly healthy repo
  // (#353). Skip honestly instead — it is not-applicable, not a failure, and those
  // repos' dependency vulnerabilities are still covered by osv-scanner. (No
  // false-green risk: OSV runs regardless.)
  const hasNpmLock = await access(resolve(root, "package-lock.json"))
    .then(() => true)
    .catch(() => false);
  if (!hasNpmLock) {
    const other = (
      await Promise.all(
        (["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"] as const).map((f) =>
          access(resolve(root, f))
            .then(() => f)
            .catch(() => null),
        ),
      )
    ).find(Boolean);
    return {
      category: "dependency",
      name: "npm audit",
      status: "skip",
      detail: other
        ? `no package-lock.json — repo uses ${other}; npm audit not applicable (deps covered by osv-scanner)`
        : "no package-lock.json — npm audit not applicable (deps covered by osv-scanner)",
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
        didNotRun: true,
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
async function checkPipAudit(root: string): Promise<SecurityCheckResult> {
  try {
    // Check if requirements.txt exists
    await access(resolve(root, "requirements.txt"));
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
      // requirements.txt is present (we returned above otherwise) → a Python
      // project's CVEs are UNSCANNED because the tool is absent: a scanner-health
      // failure under strict, not an honest skip.
      didNotRun: true,
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
async function checkEnvGitignored(root: string): Promise<SecurityCheckResult> {
  try {
    const gitignoreContent = await readFile(resolve(root, ".gitignore"), "utf-8");

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
/**
 * Per-ecosystem lockfile map (#353): for each ecosystem whose MANIFEST is present,
 * a committed lockfile of ANY kind for that ecosystem satisfies the reproducibility
 * check. Previously only package-lock.json + requirements.txt counted, so a healthy
 * pnpm/yarn/bun/cargo/go/ruby/php/dart repo that committed its own lockfile was
 * false-flagged "not committed [high]". The result `name` keeps the canonical
 * lockfile of the ecosystem (stable for coverage/citation mapping); the detail names
 * whichever lockfile actually satisfied it.
 */
export const LOCKFILE_ECOSYSTEMS: { name: string; manifests: string[]; lockfiles: string[] }[] = [
  {
    name: "package-lock.json",
    manifests: ["package.json"],
    lockfiles: [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lockb",
      "bun.lock",
    ],
  },
  {
    name: "requirements.txt",
    manifests: ["requirements.txt", "pyproject.toml", "Pipfile"],
    lockfiles: ["requirements.txt", "poetry.lock", "Pipfile.lock", "uv.lock", "pdm.lock"],
  },
  { name: "Cargo.lock", manifests: ["Cargo.toml"], lockfiles: ["Cargo.lock"] },
  { name: "go.sum", manifests: ["go.mod"], lockfiles: ["go.sum"] },
  { name: "Gemfile.lock", manifests: ["Gemfile"], lockfiles: ["Gemfile.lock"] },
  { name: "composer.lock", manifests: ["composer.json"], lockfiles: ["composer.lock"] },
  { name: "pubspec.lock", manifests: ["pubspec.yaml"], lockfiles: ["pubspec.lock"] },
  // Ecosystems where a committed lockfile is the NORM (so a missing one is a real
  // finding). Deliberately NOT here: Gradle/Maven/.NET — their lockfiles are opt-in,
  // so flagging their absence would re-introduce the #354 false-red (JVM/.NET
  // dependency vulns are covered by trivy/osv-scanner instead).
  { name: "Package.resolved", manifests: ["Package.swift"], lockfiles: ["Package.resolved"] },
  { name: "mix.lock", manifests: ["mix.exs"], lockfiles: ["mix.lock"] },
  { name: "flake.lock", manifests: ["flake.nix"], lockfiles: ["flake.lock"] },
];

async function checkLockfilesCommitted(root: string): Promise<SecurityCheckResult[]> {
  const results: SecurityCheckResult[] = [];
  const present = (f: string): Promise<boolean> =>
    access(resolve(root, f))
      .then(() => true)
      .catch(() => false);

  // Resolve git-tracked state once — a non-git tree is a single honest warn, not a
  // per-ecosystem repeat.
  let gitOk = true;
  try {
    await exec("git", ["rev-parse", "--git-dir"], { timeout: 5_000 });
  } catch {
    gitOk = false;
  }

  for (const eco of LOCKFILE_ECOSYSTEMS) {
    const hasManifest = (await Promise.all(eco.manifests.map(present))).some(Boolean);
    if (!hasManifest) continue;

    if (!gitOk) {
      results.push({
        category: "supply-chain",
        name: eco.name,
        status: "warn",
        detail: "git check failed (not in a git repo?)",
        severity: "low",
      });
      continue;
    }

    // A committed lockfile of ANY kind for this ecosystem satisfies the check.
    let committed: string | null = null;
    for (const lf of eco.lockfiles) {
      const { stdout } = await exec("git", ["ls-files", lf], { timeout: 5_000 });
      if (stdout.trim()) {
        committed = lf;
        break;
      }
    }

    if (committed) {
      results.push({
        category: "supply-chain",
        name: eco.name,
        status: "pass",
        detail: `committed to git (${committed})`,
      });
    } else {
      results.push({
        category: "supply-chain",
        name: eco.name,
        status: "fail",
        detail: `no committed lockfile for the detected ecosystem (${eco.lockfiles.slice(0, 3).join(" / ")}…)`,
        severity: "high",
      });
    }
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
    } else if (netstat.includes("127.0.0.1:3199") || netstat.includes("[::1]:3199")) {
      results.push({
        category: "exposure",
        name: "Remote API",
        status: "pass",
        detail: "localhost only",
      });
    } else {
      // Listening, but NOT on 0.0.0.0 and NOT on loopback → a routable interface
      // (a LAN IP / global IPv6). Reporting "localhost only" here would greenlight
      // an exposed approval/audit API. Gate on a POSITIVE loopback match instead.
      results.push({
        category: "exposure",
        name: "Remote API",
        status: "warn",
        detail: "listening on a non-loopback address (verify firewall / bind to 127.0.0.1)",
        severity: "medium",
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

/** Version specifiers that are local/protocol refs (workspace:, file:, link:,
 *  portal:, catalog:) — resolved outside the registry, so "floating" is
 *  meaningless for them. */
const LOCAL_PROTOCOL_REF = /^(workspace|file|link|portal|catalog):/;

/**
 * The unpinned rows of one dependency map. Workspace-aware: internal monorepo
 * packages (declared `"@repo/x": "*"` per npm-workspaces convention, or via the
 * workspace:/file: protocols) resolve to the local tree, never the registry —
 * flagging them as "unpinned" was a false positive, and "pinning" them would
 * actually be wrong. Exported for tests.
 */
export function unpinnedNodeDeps(
  deps: Record<string, string> | undefined,
  isWorkspaceMember: (name: string) => boolean,
): string[] {
  if (!deps) return [];
  const unpinned: string[] = [];
  for (const [name, version] of Object.entries(deps)) {
    if (LOCAL_PROTOCOL_REF.test(version)) continue;
    if (isWorkspaceMember(name)) continue;
    // Range specifiers: ^, ~, >, <, >=, <=, *, x
    if (/^[~^><=*x]|[*x]$/.test(version)) {
      unpinned.push(`${name}@${version}`);
    }
  }
  return unpinned;
}

/**
 * npm does not run a dependency's `preinstall`/`install`/`postinstall`/`prepare` unless
 * package.json's `allowScripts` names it, so that field IS the record of which dependencies
 * were granted install-time code execution. Shapes measured on npm 11.19.0 — the docs
 * describe `{pkg: "1.2.3"}`, the client writes the version into the KEY:
 *
 *   npm install-scripts approve esbuild                          -> {"esbuild@0.28.1": true}
 *   npm install-scripts approve esbuild --no-allow-scripts-pin   -> {"esbuild": true}
 *   npm install-scripts deny esbuild                             -> {"esbuild": false}
 *
 * A grant is only as good as the review behind it, and two shapes outlive their review: a
 * bare-name key also covers the release nobody has seen yet, and a grant left behind after
 * the dependency is dropped is a standing permission for a name an attacker can
 * re-introduce (`npm install-scripts prune` is what clears those). Pure; exported for tests.
 */
export interface AllowScriptsAudit {
  /** Keys pinned to one exact version — the reviewed shape. */
  pinned: string[];
  /** Bare-name or range keys: admit versions nobody reviewed. */
  unpinned: string[];
  /** Granted, but no longer a declared dependency. */
  stale: string[];
  /** Explicit `false` — a denial, not a grant (npm keeps denials winning). */
  denied: string[];
  /** Set when the field is not the object map npm writes — the audit could NOT run. */
  shapeError?: string;
}

/** An exact npm version (`1.2.3`, `1.2.3-rc.1`) — anything else admits more than one release. */
const EXACT_NPM_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

const ALLOW_SCRIPTS_SHAPE =
  "npm writes an object mapping `<pkg>` or `<pkg>@<spec>` to true (granted) or false (denied)";

/** Split an allowScripts key into package name + version spec. The spec is whatever follows
 *  the LAST `@`, so a scoped name (`@scope/pkg`) survives with no spec at all. */
function splitAllowScriptsKey(key: string): { name: string; spec: string } {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key, spec: "" };
  return { name: key.slice(0, at), spec: key.slice(at + 1) };
}

export function auditAllowScripts(field: unknown, declared: Set<string>): AllowScriptsAudit {
  const out: AllowScriptsAudit = { pinned: [], unpinned: [], stale: [], denied: [] };
  if (Array.isArray(field)) {
    out.shapeError = `allowScripts is an array — ${ALLOW_SCRIPTS_SHAPE}`;
    return out;
  }
  if (typeof field !== "object" || field === null) {
    out.shapeError = `allowScripts is a ${typeof field} — ${ALLOW_SCRIPTS_SHAPE}`;
    return out;
  }
  for (const [key, value] of Object.entries(field as Record<string, unknown>)) {
    if (value === false) {
      out.denied.push(key);
      continue;
    }
    // `true` is what the client writes. A string is tolerated because the docs describe a
    // range-valued form; anything else is a shape we refuse to guess at, because reading an
    // unknown allowlist as "no grants" would report the most dangerous state as the safest.
    if (value !== true && typeof value !== "string") {
      out.shapeError = `allowScripts["${key}"] is a ${typeof value} — ${ALLOW_SCRIPTS_SHAPE}`;
      return out;
    }
    const { name, spec } = splitAllowScriptsKey(key);
    if (!declared.has(name)) {
      out.stale.push(key);
      continue;
    }
    if (EXACT_NPM_VERSION.test(spec)) out.pinned.push(key);
    else out.unpinned.push(key);
  }
  return out;
}

/** One line of `.kit-triage.jsonl` — the log `kit triage` appends a PASS to, and the
 *  pre-commit `check-deps` gate reads. Only the fields this check needs. */
export interface TriageLogRow {
  type: string;
  target: string;
  timestamp: string;
}

/** Did anything ever evaluate the package we granted install-script execution to?
 *
 * The allowScripts audit can only see the SHAPE of a grant. This asks the question that
 * shape cannot answer: an unpinned grant for a package kit triaged yesterday is a different
 * risk from a pinned grant for a package nothing has ever looked at.
 *
 * `ledger === null` means the log does not exist — most repos have never run `kit triage` —
 * and is reported as "the cross-check did not run", never as "nothing was triaged". A
 * confident finding built on an absent file is exactly the failure mode this codebase keeps
 * finding in itself. Pure; exported for tests.
 */
export interface TriageCoverage {
  /** Granted, with no matching triage entry at all. */
  untriaged: string[];
  /** Granted and triaged, but every entry is older than the freshness window. */
  stale: string[];
  /** No ledger to consult — the cross-check could not run. */
  ledgerMissing?: boolean;
}

export function grantsTriageCoverage(
  grantKeys: string[],
  ledger: TriageLogRow[] | null,
  now: number,
  maxAgeDays: number = TRIAGE_MAX_AGE_DAYS,
): TriageCoverage {
  if (ledger === null) return { untriaged: [], stale: [], ledgerMissing: true };
  const cutoff = now - maxAgeDays * 86_400_000;
  // The ledger records `rest` from an `npm:<rest>` ref, so an entry may carry a version
  // while the grant key does not (or the reverse). Identity is the NAME.
  const npmEntries = ledger
    .filter((row) => row.type === "npm")
    .map((row) => ({ name: splitAllowScriptsKey(row.target).name, at: Date.parse(row.timestamp) }))
    .filter((row) => Number.isFinite(row.at));
  const out: TriageCoverage = { untriaged: [], stale: [] };
  for (const key of grantKeys) {
    const { name } = splitAllowScriptsKey(key);
    const matches = npmEntries.filter((row) => row.name === name);
    if (matches.length === 0) {
      out.untriaged.push(key);
      continue;
    }
    if (!matches.some((row) => row.at >= cutoff)) out.stale.push(key);
  }
  return out;
}

/** Read `.kit-triage.jsonl`, tolerating a damaged line rather than failing the check.
 *  Returns null when the log does not exist — see `grantsTriageCoverage`. */
async function readTriageLedger(root: string): Promise<TriageLogRow[] | null> {
  let text: string;
  try {
    text = await readFile(resolve(root, ".kit-triage.jsonl"), "utf-8");
  } catch {
    return null;
  }
  const rows: TriageLogRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as TriageLogRow;
      if (typeof row.type === "string" && typeof row.target === "string") rows.push(row);
    } catch {
      // a torn append is not a reason to fail the check — skip the line
    }
  }
  return rows;
}

/** The check around `auditAllowScripts`. Root package.json only — that is the manifest npm
 *  consults for the project's grants. */
export async function checkAllowScripts(root: string): Promise<SecurityCheckResult> {
  const name = "install-script grants";
  const rule = ruleForCheck(name);
  const base = { category: "supply-chain", name, rule } as const;
  let pkg: {
    allowScripts?: unknown;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...base, status: "skip", detail: "no package.json" };
    }
    return {
      ...base,
      status: "warn",
      didNotRun: true,
      severity: "medium",
      detail: `package.json could not be read: ${(err as Error).message}`,
    };
  }
  if (pkg.allowScripts === undefined) {
    return {
      ...base,
      status: "skip",
      detail: "no install-script grant declared (npm skips dependency install scripts by default)",
    };
  }
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  const audit = auditAllowScripts(pkg.allowScripts, declared);
  if (audit.shapeError) {
    return {
      ...base,
      status: "warn",
      didNotRun: true,
      severity: "medium",
      detail: audit.shapeError,
      suggestion:
        "rewrite the field with `npm install-scripts approve <pkg>` so npm owns its shape",
    };
  }
  // The shape audit says how BROAD each grant is. The triage cross-check says whether
  // anything ever evaluated the package it was granted to — a pinned grant for a package
  // nothing has looked at is worse than an unpinned grant for one kit cleared yesterday,
  // so it carries the higher severity.
  const grants = [...audit.pinned, ...audit.unpinned];
  const coverage = grantsTriageCoverage(grants, await readTriageLedger(root), Date.now());

  const problems: string[] = [];
  if (coverage.untriaged.length > 0) {
    problems.push(
      `${coverage.untriaged.length} grant(s) never triaged: ${coverage.untriaged.join(", ")} — install-script execution granted to a package nothing evaluated`,
    );
  }
  if (coverage.stale.length > 0) {
    problems.push(
      `${coverage.stale.length} grant(s) whose triage is older than ${TRIAGE_MAX_AGE_DAYS} days: ${coverage.stale.join(", ")}`,
    );
  }
  if (audit.unpinned.length > 0) {
    problems.push(
      `${audit.unpinned.length} unpinned grant(s): ${audit.unpinned.join(", ")} — covers releases nobody reviewed`,
    );
  }
  if (audit.stale.length > 0) {
    problems.push(
      `${audit.stale.length} stale grant(s): ${audit.stale.join(", ")} — no longer a declared dependency`,
    );
  }
  // Reported when the log is absent so a green row cannot be mistaken for "every grant is
  // triaged" — the check ran, one of its questions could not be asked.
  const crossCheck = coverage.ledgerMissing
    ? " · triage cross-check did not run (no .kit-triage.jsonl in this repo)"
    : "";
  if (problems.length > 0) {
    return {
      ...base,
      status: "warn",
      // An untriaged grant is a different class from a too-broad one: nothing has evaluated
      // the code that will run.
      severity: coverage.untriaged.length > 0 ? "high" : "medium",
      detail: problems.join("; ") + crossCheck,
      suggestion:
        coverage.untriaged.length > 0
          ? "triage before granting: `kit triage npm <pkg>`, then re-approve pinned (`npm install-scripts approve <pkg>`); clear outlived grants with `npm install-scripts prune`"
          : "re-approve pinned (`npm install-scripts approve <pkg>` writes <pkg>@<version> by default), and clear the outlived ones with `npm install-scripts prune`",
    };
  }
  const denied = audit.denied.length > 0 ? ` · ${audit.denied.length} denied` : "";
  return {
    ...base,
    status: "pass",
    detail: `${audit.pinned.length} grant(s), every one pinned to an exact version${denied}${crossCheck}`,
  };
}

/** Names of this repo's workspace member packages (empty set when none / on error). */
function workspaceMemberNames(cwd: string): Set<string> {
  const names = new Set<string>();
  try {
    for (const root of resolveWorkspaceRoots(cwd)) {
      try {
        const pkg = JSON.parse(readFileSync(resolve(cwd, root, "package.json"), "utf-8")) as {
          name?: string;
        };
        if (pkg.name) names.add(pkg.name);
      } catch {
        // unreadable member package.json — skip it, never fail the check
      }
    }
  } catch {
    // workspace resolution is best-effort; no workspaces ⇒ empty set
  }
  return names;
}

/**
 * Check if dependencies use pinned versions
 */
async function checkPinnedVersions(root: string): Promise<SecurityCheckResult> {
  const unpinned: string[] = [];

  // Check package.json
  try {
    const packageJsonContent = await readFile(resolve(root, "package.json"), "utf-8");
    const packageJson = JSON.parse(packageJsonContent);
    const members = workspaceMemberNames(root);
    const isMember = (name: string) => members.has(name);

    unpinned.push(
      ...unpinnedNodeDeps(packageJson.dependencies, isMember),
      ...unpinnedNodeDeps(packageJson.devDependencies, isMember),
    );
  } catch {
    // No package.json or parse error
  }

  // Check requirements.txt
  try {
    const requirementsContent = await readFile(resolve(root, "requirements.txt"), "utf-8");

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
/**
 * Public-by-design client keys (#250): shapes that SHIP in client bundles on
 * purpose — "rotate now" is wrong advice for them; the real control is key
 * restrictions / security rules. Curated allowlist, one entry per shape:
 *   - firebase-web-config: an AIza… Google API key, but ONLY when the finding's
 *     file also carries Firebase web-config context (authDomain/projectId/
 *     firebaseConfig). An AIza key WITHOUT that context stays a normal finding —
 *     it could be a privileged server key (conservative default).
 *   - sentry-dsn / posthog-project-key: inherently client-side by shape alone.
 */
const AIZA_RE = /AIza[0-9A-Za-z_-]{35}/;
const FIREBASE_CONTEXT_RE = /authDomain|firebaseConfig|messagingSenderId|projectId/;
const SENTRY_DSN_RE = /https:\/\/[0-9a-f]{16,}@[a-z0-9.-]*sentry\.io\/\d+/;
const POSTHOG_KEY_RE = /phc_[A-Za-z0-9]{40,}/;

export interface TrufflehogFinding {
  verified: boolean;
  raw: string;
  file?: string;
  detector?: string;
  commit?: string;
}

/** One accepted historical finding from `.kit-secretsignore`. */
export interface SecretsIgnoreEntry {
  commit: string;
  file: string;
  detector: string;
}

/**
 * Parse `.kit-secretsignore` — one accepted historical finding per line, as
 * `<commit>:<file>:<detector>`, with `#` comments and blank lines ignored.
 *
 * Why a file and not a config flag: a repo's history is immutable, so a fixture that
 * was committed once is a finding forever. Without a way to accept it by name, the
 * secrets check sits at warn permanently and stops being read — the failure mode this
 * whole classifier exists to prevent. Unlike a blanket path or regex allowlist, an
 * entry names ONE commit, so it cannot wave through a future occurrence of the same
 * string. (kit's own file records the fixture literals from d9f55af.)
 *
 * `file` may be `*` for the findings trufflehog reports without a path. Commits must be
 * at least 7 hex chars — anything shorter is too ambiguous to accept, and malformed
 * lines are dropped rather than guessed at. Pure.
 */
export function parseSecretsIgnore(text: string): SecretsIgnoreEntry[] {
  const entries: SecretsIgnoreEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(":");
    if (parts.length !== 3) continue;
    const [commit, file, detector] = parts.map((p) => p.trim());
    if (!/^[0-9a-f]{7,40}$/i.test(commit) || !file || !detector) continue;
    entries.push({ commit: commit.toLowerCase(), file, detector });
  }
  return entries;
}

/**
 * True when a finding is explicitly accepted by `.kit-secretsignore`.
 *
 * A VERIFIED-LIVE finding is never ignorable: if trufflehog reached the provider and
 * the credential still works, no file entry may silence it. Matching is exact on file
 * (or `*`) and detector, and prefix-based on the commit so an abbreviated sha works.
 */
export function isIgnoredFinding(f: TrufflehogFinding, entries: SecretsIgnoreEntry[]): boolean {
  if (f.verified) return false; // a live credential is never waved through
  if (!f.commit) return false; // nothing to scope an acceptance to
  const commit = f.commit.toLowerCase();
  return entries.some(
    (e) =>
      commit.startsWith(e.commit) &&
      (e.file === "*" || e.file === f.file) &&
      e.detector.toLowerCase() === (f.detector ?? "").toLowerCase(),
  );
}

/**
 * True when a finding is a public-by-design client key. `readFile` supplies the
 * finding's CURRENT worktree content for co-occurrence checks; returning null
 * (file gone / unreadable) keeps the finding a normal one — never downgrade on
 * missing evidence.
 */
export function isPublicByDesign(
  f: TrufflehogFinding,
  readFile: (path: string) => string | null,
): boolean {
  if (f.verified) return false; // a VERIFIED-LIVE credential is never waved through
  if (SENTRY_DSN_RE.test(f.raw) || POSTHOG_KEY_RE.test(f.raw)) return true;
  if (AIZA_RE.test(f.raw) && f.file) {
    const content = readFile(f.file);
    if (content && FIREBASE_CONTEXT_RE.test(content)) return true;
  }
  return false;
}

/**
 * Example credentials: unverified findings whose OWN VALUE proves they never named a
 * real account — test fixtures, `docker-compose` dev defaults, doc placeholders. They
 * are permanent by design (a redaction test needs a secret-shaped string to redact),
 * so leaving them in the reviewable bucket means a warn that can never go down, which
 * trains the reader to ignore the whole line. Reported in their own bucket instead.
 *
 * Two deterministic, value-only signals — never the file path. A real credential
 * pasted into a test file still gets flagged; only the value can wave one through:
 *
 *   1. UNREACHABLE HOST — loopback, an unqualified single-label host (a compose/k8s
 *      service name like `db` or `postgres`), or a reserved suffix (`.internal`,
 *      `.local`, `.test`, `.invalid`, `example.com`). None can name a service on the
 *      public internet, so the pair cannot be a live credential anywhere off-host.
 *   2. PLACEHOLDER SECRET — the password/token is a dictionary stand-in (`pass`,
 *      `password`, `changeme`, …), or the literal sample token from a vendor's own
 *      docs. Nobody's live secret is the word "password".
 *
 * Conservative by construction: a real-shaped secret on a routable host is NOT an
 * example, and a VERIFIED-LIVE finding is never one whatever its shape.
 */
const PLACEHOLDER_SECRETS = new Set([
  "pass",
  "passwd",
  "password",
  "pw",
  "secret",
  "changeme",
  "change-me",
  "example",
  "mypassword",
  "yourpassword",
  "your_password",
  "your-password",
  "<password>",
  "xxx",
  "xxxx",
]);
/**
 * Sample tokens published in vendors' own docs — famous, dead, and everywhere.
 *
 * Held as SHA-256 digests, not literals: a literal sample PAT in a non-test source file
 * is itself a `github-pat` hit for this repo's gitleaks job (it fired on exactly that,
 * and it was right to). Digests keep the allowlist auditable — recompute with
 * `printf %s '<token>' | shasum -a 256` — without shipping token-shaped bytes.
 *   868034cf… = GitHub's documented example PAT (docs.github.com REST auth examples).
 */
const DOC_SAMPLE_SECRET_DIGESTS = new Set([
  "868034cf6e8877d082cf2e61a4964c04affcbfd6abf8a8d0339ce3298636fa57",
]);
const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;
const RESERVED_HOST_RE = /\.(internal|local|localdomain|localhost|test|invalid|example)$/i;
const EXAMPLE_DOMAIN_RE = /^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i;
/** `scheme://[user[:secret]@]host[:port]` — the shape every URI-credential detector emits. */
const URI_CREDENTIAL_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:([^:@/\s]+)(?::([^@/\s]*))?@)?([^/?#\s]+)/i;

export function isExampleCredential(f: TrufflehogFinding): boolean {
  if (f.verified) return false; // a VERIFIED-LIVE credential is never waved through
  const raw = f.raw.trim();
  if (DOC_SAMPLE_SECRET_DIGESTS.has(createHash("sha256").update(raw).digest("hex"))) return true;

  const m = URI_CREDENTIAL_RE.exec(raw);
  if (!m) return false;
  const [, , secret, hostPort] = m;
  if (secret !== undefined && PLACEHOLDER_SECRETS.has(secret.toLowerCase())) return true;

  const host = hostPort.replace(/:\d+$/, "").toLowerCase();
  if (LOOPBACK_HOST_RE.test(host)) return true;
  if (RESERVED_HOST_RE.test(host) || EXAMPLE_DOMAIN_RE.test(host)) return true;
  // Unqualified single-label host — a compose/k8s service name, not a public DNS name.
  // Bracketed IPv6 and dotted names are excluded by the dot/colon check.
  return !host.includes(".") && !host.includes(":");
}

export function classifyTrufflehogFindings(
  stdout: string,
  readFile: (path: string) => string | null = () => null,
  ignores: SecretsIgnoreEntry[] = [],
): {
  verified: number;
  unverified: number;
  publicByDesign: number;
  example: number;
  ignored: number;
} {
  let verified = 0;
  let unverified = 0;
  let publicByDesign = 0;
  let example = 0;
  let ignored = 0;
  for (const line of stdout.trim().split("\n")) {
    if (!line.includes('"DetectorName"')) continue;
    try {
      const j = JSON.parse(line) as {
        DetectorName?: string;
        Verified?: boolean;
        Raw?: string;
        SourceMetadata?: { Data?: { Git?: { file?: string; commit?: string } } };
      };
      const finding: TrufflehogFinding = {
        verified: j.Verified === true,
        raw: j.Raw ?? "",
        file: j.SourceMetadata?.Data?.Git?.file,
        detector: j.DetectorName,
        commit: j.SourceMetadata?.Data?.Git?.commit,
      };
      if (finding.verified) verified++;
      else if (isPublicByDesign(finding, readFile)) publicByDesign++;
      else if (isExampleCredential(finding)) example++;
      else if (isIgnoredFinding(finding, ignores)) ignored++;
      else unverified++;
    } catch {
      unverified++;
    }
  }
  return { verified, unverified, publicByDesign, example, ignored };
}

/**
 * Scan for secrets in code using trufflehog or basic pattern matching
 */
/**
 * Filter git-grep hits from the DEGRADED secrets path (no trufflehog) down to the files
 * worth a warn. It's an UNVERIFIED grep, so it drops the three dominant false-positive
 * classes to not drown real signal:
 *   1. test / fixture / mock files — fake credentials live here by design
 *      (`sk_test_invalid_for_test...`, sample JWTs). The AUTHORITATIVE scanners
 *      (trufflehog + the CI gitleaks job) still scan these and verify live, so
 *      suppressing them HERE only de-noises the local stopgap, it does not weaken
 *      the real gate.
 *   2. all-caps identifier VALUES — an env-var NAME like `SOCKET_SECURITY_API_TOKEN`
 *      is a config key, never a secret.
 *   3. pure substitution EXPRESSIONS — `${{ secrets.X }}` (GitHub Actions), `${VAR}`
 *      (shell/compose), `{{ .Values.x }}` (Helm/Jinja), `$(cmd)` (shell command
 *      substitution). These are the CORRECT way to reference a secret, never a literal
 *      credential (found flagging curl's workflows and llm's contributing docs in the
 *      findings sweep).
 * Input: `git grep -n` output lines (`file:line:content`). Pure and deterministic.
 */
export function basicSecretScanFiles(lines: string[]): string[] {
  const TEST_PATH = /(\.test\.|\.spec\.|__tests__|\/__mocks__\/|\/fixtures?\/|\.fixture\.)/;
  const VALUE_RE =
    /(?:api[_-]?key|secret[_-]?key|password|token|credential)["']?\s*[:=]\s*["']([^"']{20,})/i;
  const TEMPLATE_VALUE =
    /^\s*(\$\{\{[^}]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_:.-]*\}|\{\{[^}]*\}\}|\$\([^)]*\))\s*$/;
  const files = new Set<string>();
  for (const line of lines) {
    const m = line.match(/^([^:]+):\d+:(.*)$/);
    if (!m) continue;
    const [, file, content] = m;
    if (TEST_PATH.test(file)) continue;
    const value = content.match(VALUE_RE)?.[1] ?? "";
    if (/^[A-Z][A-Z0-9_]+$/.test(value)) continue; // env-var name, not a secret
    if (TEMPLATE_VALUE.test(value)) continue; // substitution syntax, not a literal
    files.add(file);
  }
  return [...files];
}

async function checkSecretsInCode(root: string): Promise<SecurityCheckResult> {
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
        ["git", `file://${root}`, "--json", "--no-update"],
        { timeout: 90_000 },
      );

      // Split verified-live from unverified (#noise-reduction). Only a VERIFIED
      // secret — one trufflehog confirmed still works — is a critical fail (rotate
      // now). Unverified secret-shaped strings (overwhelmingly test fixtures /
      // example connection strings) are a warn to review, not a release-blocking
      // critical. Avoids failing a clean repo on its own test data.
      // Public-by-design client keys (#250: Firebase web config, Sentry DSN,
      // PostHog) are split out with truthful advice — rotating them fixes nothing.
      const readWorktreeFile = (p: string): string | null => {
        try {
          return readFileSync(resolve(root, p), "utf8");
        } catch {
          return null;
        }
      };
      // Accepted historical findings, if the repo keeps a .kit-secretsignore. Absent
      // file ⇒ no acceptances, which is the correct default for a repo that has never
      // reviewed one.
      let ignores: SecretsIgnoreEntry[] = [];
      try {
        ignores = parseSecretsIgnore(readFileSync(resolve(root, ".kit-secretsignore"), "utf8"));
      } catch {
        // no ignore file (or unreadable) — treat every finding on its own merits
      }
      const { verified, unverified, publicByDesign, example, ignored } = classifyTrufflehogFindings(
        stdout,
        readWorktreeFile,
        ignores,
      );
      const pbdNote =
        publicByDesign > 0
          ? `; ${publicByDesign} public-by-design client key(s) (Firebase web config / DSN) — verify API-key restrictions + security rules, rotation not applicable`
          : "";
      // Example credentials are counted, not hidden: a reader can still see how many
      // there are, but they don't hold the line at warn forever (see isExampleCredential).
      const exampleNote =
        example > 0
          ? `; ${example} example credential(s) (unreachable host / placeholder secret — fixtures & docs), no rotation needed`
          : "";
      const ignoredNote =
        ignored > 0 ? `; ${ignored} accepted historical finding(s) via .kit-secretsignore` : "";

      if (verified > 0) {
        return {
          category: "secrets",
          name: "secrets scan",
          status: "fail",
          detail: `${verified} VERIFIED-LIVE secret(s) in git history -rotate now; run: trufflehog git file://.${pbdNote}${exampleNote}${ignoredNote}`,
          severity: "critical",
        };
      }
      if (unverified > 0) {
        return {
          category: "secrets",
          name: "secrets scan",
          status: "warn",
          detail: `${unverified} unverified secret-shaped string(s) in git history (0 verified-live) — review for test/example data: trufflehog git file://.${pbdNote}${exampleNote}${ignoredNote}`,
          severity: "medium",
        };
      }

      return {
        category: "secrets",
        name: "secrets scan",
        status: "pass",
        // Name the detector, not just the outcome: this path's coverage is trufflehog's set over
        // full history, which is a different (much larger) bound than kit's own pattern list used
        // by scan-staged and scan-build. A reader cannot size "no committed secrets" without it.
        detail: `no committed secrets (trufflehog detector set, full history)${pbdNote}${exampleNote}${ignoredNote}`,
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
        const files = basicSecretScanFiles(stdout.trim().split("\n"));

        if (files.length > 0) {
          return {
            category: "secrets",
            name: "secrets scan",
            status: "warn",
            detail: `${files.length} file(s) with unverified secret-shaped strings (basic scan, trufflehog absent — HEAD/working-tree only, does NOT scan git history) — review for real credentials`,
            severity: "medium",
            files,
            suggestion:
              "Install trufflehog for verified detection (it confirms live secrets, skipping test/example data):\n  • kit install (provisions the declared aqua:trufflesecurity/trufflehog)\n  • macOS/Linux: brew install trufflehog\n  • Go: go install github.com/trufflesecurity/trufflehog/v3@latest",
          };
        }
      }
    } catch {
      // No matches or git grep failed
    }

    return {
      category: "secrets",
      name: "secrets scan",
      status: "pass",
      detail:
        "basic scan: no secret-shaped strings outside tests/fixtures — HEAD/working-tree only, NOT git history; install trufflehog for full-history + verified detection",
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
async function checkGuardDog(root: string): Promise<SecurityCheckResult> {
  const base = { category: "supply-chain", name: "guarddog (malware)" } as const;
  const envEnabled = ["1", "true", "yes", "on"].includes(
    (process.env.KIT_GUARDDOG ?? "").trim().toLowerCase(),
  );
  // Persistent project opt-in via `.kit.toml [scan] guarddog = true` (best-effort
  // config read) — so the choice lives in config, not just an ephemeral env var.
  let cfgEnabled = false;
  try {
    const { loadConfig } = await import("./config.js");
    const cfg = await loadConfig(resolve(root, ".kit.toml"));
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

  // Direct deps first (#205): guarddog costs ~25s/package (tarball + per-package
  // semgrep) — a 12k-package lockfile can NEVER finish inside the check budget,
  // so verifying it always produced an honest-but-useless UNVERIFIED. Direct
  // deps are guarddog's depth; the full tree gets breadth from bumblebee + osv.
  const candidates: { ecosystem: string; file: string }[] = [
    { ecosystem: "npm", file: "package.json" },
    { ecosystem: "pypi", file: "requirements.txt" },
  ];
  let target: { ecosystem: string; file: string } | undefined;
  for (const c of candidates) {
    try {
      await access(resolve(root, c.file));
      target = c;
      break;
    } catch {
      // not present — try the next
    }
  }
  if (!target) {
    return { ...base, status: "skip", detail: "no package.json / requirements.txt to scan" };
  }

  const bin = await resolveToolBin("guarddog");
  if (!bin) {
    return {
      ...base,
      status: "warn",
      detail: "guarddog not installed — malware heuristics unavailable",
      severity: "medium",
      suggestion: "mise use pipx:guarddog",
      // guarddog is opted in (env/config) AND a manifest is present, but the tool
      // is absent → the opted-in malware scan did NOT run (mirrors semgrep below).
      didNotRun: true,
    };
  }

  // Verdict cache (#205): an unchanged direct-deps set with a completed clean
  // scan doesn't re-pay the ~25s/package cost. Only CLEAN verdicts are cached;
  // fails and incomplete scans always re-run. npm only (the hash reads
  // package.json deps).
  let depsHash: string | null = null;
  if (target.ecosystem === "npm") {
    try {
      depsHash = depsHashFor(readFileSync(resolve(root, target.file), "utf8"));
    } catch {
      depsHash = null;
    }
    const cached = depsHash ? loadGuardDogCache() : null;
    if (cached && depsHash && cached.depsHash === depsHash) {
      return {
        ...base,
        status: "pass",
        detail: `no malware indicators — cached clean verdict from ${cached.scannedAt.slice(0, 10)} (${cached.packages} direct dep(s), unchanged since)`,
      };
    }
  }

  const timeoutMs = Number(process.env.KIT_GUARDDOG_TIMEOUT_MS ?? "") || 300_000;
  const result = await execFileNoThrow(
    bin,
    [target.ecosystem, "verify", target.file, "--output-format=json"],
    { timeout: timeoutMs, cwd: root },
  );
  const verdict = classifyGuardDog(result.stdout || result.stderr);
  if (verdict.status === "pass" && depsHash) {
    const packages = Number(verdict.detail.match(/\((\d+) package/)?.[1] ?? 0);
    saveGuardDogCache({ depsHash, scannedAt: new Date().toISOString(), packages });
  }
  return verdict;
}

/**
 * Scan Dockerfile and filesystem for CVEs using Trivy.
 * Catches OS-level vulnerabilities that npm audit misses.
 */
async function checkTrivy(root: string): Promise<SecurityCheckResult> {
  const hasDockerfile = await access(resolve(root, "Dockerfile"))
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
      // A Dockerfile is present but trivy is absent → container CVEs UNSCANNED: a
      // scanner-health failure under strict, not an honest skip.
      didNotRun: true,
    };
  }

  const result = await execFileNoThrow(
    trivyBin,
    ["fs", ".", "--format", "json", "--severity", "HIGH,CRITICAL", "--quiet"],
    { timeout: 120_000, cwd: root },
  );

  if (!result.ok && !result.stdout) {
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "warn",
      detail: "trivy scan failed",
      severity: "medium",
      didNotRun: true,
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
      didNotRun: true,
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
async function checkTrivyConfig(root: string): Promise<SecurityCheckResult> {
  const name = "trivy config (IaC)";
  const cwd = root;
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
      // IaC (Dockerfile/Compose/Terraform) is present but trivy is absent → those
      // misconfigurations are UNSCANNED: a scanner-health failure under strict.
      didNotRun: true,
    };
  }

  const result = await execFileNoThrow(
    trivyBin,
    ["config", ".", "--format", "json", "--severity", "HIGH,CRITICAL", "--quiet"],
    { timeout: 120_000, cwd: root },
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
async function checkMavenAudit(root: string): Promise<SecurityCheckResult> {
  const found = await findJvmProject(root);
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
      // A Maven/Gradle project is present but trivy is absent → JVM dependency CVEs
      // are UNSCANNED: a scanner-health failure under strict, not an honest skip.
      didNotRun: true,
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
    { timeout: 180_000, cwd: root },
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
async function checkOsvScanner(root: string): Promise<SecurityCheckResult> {
  const name = "osv-scanner (deps)";
  // osv covers ecosystems kit has no dedicated scanner for (go/rust/php/ruby/dart).
  // If none is present, osv legitimately does not apply → an honest skip. If one IS
  // present, osv absent/failed means those deps are UNSCANNED → WARN (so --strict
  // catches it), never a silent "clean".
  const osvEcosystemPresent = async (): Promise<boolean> => {
    for (const m of ["go.mod", "Cargo.lock", "composer.lock", "Gemfile.lock", "pubspec.lock"]) {
      try {
        await access(resolve(root, m));
        return true;
      } catch {
        /* not present */
      }
    }
    return false;
  };
  const osvBin = await resolveToolBin("osv-scanner");
  if (!osvBin) {
    return (await osvEcosystemPresent())
      ? {
          category: "supply-chain",
          name,
          status: "warn",
          detail:
            "osv-scanner not installed but go/rust/php/ruby manifests are present — those dependency CVEs are UNSCANNED (mise use aqua:google/osv-scanner)",
          severity: "medium",
          didNotRun: true,
        }
      : {
          category: "supply-chain",
          name,
          status: "skip",
          detail: "osv-scanner not installed (no go/rust/php/ruby/dart manifests to scan)",
        };
  }
  const result = await execFileNoThrow(osvBin, ["--format", "json", "-r", "."], {
    timeout: 120_000,
    cwd: root,
  });
  const count = parseOsvVulnCount(result.stdout);
  if (count < 0) {
    // No parseable JSON. If an osv ecosystem IS present the run FAILED (crash/timeout/
    // arg-incompat) and must not read as clean → WARN. Otherwise it's the genuine
    // no-lockfiles case → honest skip.
    return (await osvEcosystemPresent())
      ? {
          category: "supply-chain",
          name,
          status: "warn",
          detail:
            "osv-scanner produced no parseable result despite go/rust/php manifests — the run likely failed (crash/timeout); deps are UNSCANNED",
          severity: "medium",
          didNotRun: true,
        }
      : { category: "supply-chain", name, status: "skip", detail: "no lockfiles to scan" };
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
async function checkLicenses(root: string): Promise<SecurityCheckResult> {
  try {
    await access(resolve(root, "package.json"));
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
      // Neither the binary nor the npx fallback is available → the license scan
      // could not run at all: a scanner-health failure under strict, not a skip.
      didNotRun: true,
    };
  }

  const PROBLEMATIC = ["GPL", "AGPL", "LGPL", "CPAL", "OSL", "EUPL"];
  const result = await execFileNoThrow(runner.cmd, [...runner.baseArgs, "--json", "--production"], {
    timeout: 120_000,
    cwd: root,
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
async function checkSemgrep(root: string): Promise<SecurityCheckResult> {
  // Opt-in FIRST: a networked, multi-second SAST scan does not run by default.
  // Not opted in → skipping is honest (green stays "0 unreviewed").
  if (!process.env.KIT_SEMGREP_CONFIG?.trim()) {
    return {
      category: "supply-chain",
      name: "semgrep SAST",
      status: "skip",
      detail:
        "SAST opt-in: set KIT_SEMGREP_CONFIG (e.g. p/default, or a local ruleset path) to enable",
    };
  }

  // Opted in → SAST is EXPECTED to run. If semgrep is absent, that is NOT a legit
  // skip: the operator asked for SAST and it didn't happen → WARN (so --strict
  // catches an unreviewed commit) rather than a silent green.
  // Resolve mise-first (see socket): a mise-installed semgrep isn't on kit's PATH.
  const semgrepBin = await resolveToolBin("semgrep");
  if (!semgrepBin) {
    return {
      category: "supply-chain",
      name: "semgrep SAST",
      status: "warn",
      detail:
        "KIT_SEMGREP_CONFIG is set (SAST opted in) but semgrep is not installed — SAST did NOT run (mise use pipx:semgrep, or brew install semgrep)",
      severity: "medium",
      didNotRun: true,
    };
  }

  const semgrepCfg = semgrepConfig(process.env);

  // Provable air-gap: a registry ('p/...') ruleset egresses to the semgrep
  // registry on first run. In air-gap mode refuse it (only a LOCAL ruleset path
  // may run) — an honest skip, never a silent egress. Mirrors the scanner-runner
  // air-gap path so `kit ci` cannot leak where `kit scan` would not.
  if (isAirGap(process.env) && !isLocalSemgrepConfig(semgrepCfg)) {
    return {
      category: "supply-chain",
      name: "semgrep SAST",
      status: "skip",
      detail: `air-gap: refusing registry semgrep config '${semgrepCfg}' (would egress) — set KIT_SEMGREP_CONFIG to a local ruleset path`,
    };
  }

  const result = await execFileNoThrow(
    semgrepBin,
    buildSemgrepArgs({ mode: "json", config: semgrepCfg }),
    { timeout: 120_000, cwd: root },
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
async function checkBumblebee(root: string): Promise<SecurityCheckResult> {
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
    // WRITE, not a read: bumblebee findings are appended to <root>/.kit-findings.jsonl. Omitting
    // the third argument defaulted it to process.cwd(), so a check run FOR another project
    // appended that project's supply-chain findings to the calling process's file.
    //
    // Why the cross-project probe could not catch it: NOT because bumblebee is absent — it is
    // provisioned under ~/.kit/tools/bumblebee/<version>/ and does run (measured: `pass`,
    // 36 packages, on a clean fixture). The branch is gated on `findings.length > 0`, and a
    // freshly created temp project has no known exposures, so the write is unreachable from any
    // fixture that is clean. Found by enumerating the write surface instead. A green probe over a
    // clean fixture says nothing about the code paths that only a dirty one reaches.
    await logSupplyChainFindings(outcome.findings, profile, root).catch(() => {});
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
  // Catalog age is ADVISORY, not part of the verdict: it's a pure function of the
  // wall clock, so letting it flip pass→warn would make `kit ci --strict` return
  // a different verdict for the same repo + same scanners purely because the
  // calendar advanced (non-deterministic gate). We keep `status: "pass"` and
  // surface the staleness in the detail/suggestion instead, so the signal stays
  // visible without the gate depending on the date.
  const newest = await newestCatalogMtime(install.catalogDir);
  if (newest !== null) {
    const { stale, ageDays } = isCatalogStale(newest, Date.now());
    if (stale) {
      // Cached-only lookup: whether a newer release EXISTS is the other half of "your
      // catalogs are old", but it must not put a network call in the check path — the
      // check's output would then depend on whether a GitHub request succeeded. The
      // cache is populated by the post-command notice in cli.ts.
      const { readCachedBumblebeeUpdateSync } = await import("./bumblebee-update.js");
      const upd = readCachedBumblebeeUpdateSync(BUMBLEBEE_VERSION);
      // Neither branch ASSERTS that a bump refreshes the catalogs — it depends on the
      // release. (v0.1.1 → v0.1.2 did: 6 → 11 catalogs, 65 → 38 days. But the six
      // pre-existing files were byte-identical, so a bump can also change nothing.)
      const suggestion = upd
        ? `bumblebee ${upd.latest} is available (pinned ${upd.pinned}). Moving BUMBLEBEE_VERSION + TARBALL_CHECKSUMS together in src/bumblebee.ts is the only way to change the bundled catalogs — compare the release tarball's threat_intel/ to see what it actually adds.`
        : "No newer bumblebee release is known here (the check is cached, suppressed, or upstream has published none), so this age may be upstream's own rather than a lagging pin.";
      return {
        category,
        name,
        status: "pass",
        detail:
          `no known exposures (${outcome.packagesScanned} packages); note: threat-intel catalogs are ${ageDays} days old (advisory — not gated)` +
          (upd ? `; bumblebee ${upd.latest} is available upstream (pinned ${upd.pinned})` : ""),
        suggestion,
        // Dedup identity excludes ageDays on purpose: the age climbs every single day,
        // so keying on it would open a NEW ledger row per day instead of keeping one
        // open item. It does include whether an upstream bump is known, so the row is
        // replaced (not silently kept stale) when "old catalogs" becomes "old catalogs,
        // and here is the version to bump to".
        advisory: {
          key: upd ? `bumblebee-catalogs-stale:${upd.latest}` : "bumblebee-catalogs-stale",
          title: upd
            ? `bumblebee ${upd.latest} available (pinned ${upd.pinned}, catalogs ${ageDays}d old)`
            : `bumblebee threat-intel catalogs ${ageDays} days old`,
          detail: suggestion,
        },
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
export async function checkSecurity(cwd?: string): Promise<SecurityCheckResult[]> {
  // The GOVERNED project's root, threaded to every sub-check and to every scanner spawn.
  //
  // Before this, all fifteen sub-checks resolved paths from `process.cwd()` and none of the seven
  // scanner spawns passed a `cwd`, so a caller that supplied one got a verdict about the CALLING
  // process's tree. Measured over MCP: `kit_check({cwd: B})` from a server launched in A answered
  // `pass — all .env patterns in .gitignore` for a project B that has no `.gitignore` at all.
  // The config came from B; the verdict came from A. That is the worst shape a gate can fail in.
  //
  // Passing the path alone would not have fixed it: `trivy fs .`, `osv-scanner -r .` and
  // `semgrep .` all resolve "." against the spawned process's cwd, so they would still have read
  // the caller's tree while the parameter made the call look threaded. Both halves are required,
  // and the test asserts the OUTCOME differs between two trees rather than that `cwd` was passed.
  const root = cwd ?? process.cwd();
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
    allowScriptsResult,
    ...lockfileResults
  ] = await Promise.all([
    checkNpmAudit(root),
    checkPipAudit(root),
    checkEnvGitignored(root),
    checkPinnedVersions(root),
    checkSecretsInCode(root),
    checkSocket(),
    checkTrivy(root),
    checkLicenses(root),
    checkSemgrep(root),
    checkBumblebee(root),
    checkTrivyConfig(root),
    checkOsvScanner(root),
    checkMavenAudit(root),
    checkGuardDog(root),
    checkAllowScripts(root),
    ...(await checkLockfilesCommitted(root)),
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
    allowScriptsResult,
  );
  results.push(...lockfileResults);

  const exposureResults = await checkServiceExposure();
  results.push(...exposureResults);

  // At-rest exposure of kit's own secret-dense local state: verify full-disk
  // encryption is on, and that the memory store isn't redirected into a repo.
  const { checkDiskEncryption, checkMemoryDirSafety } = await import("./check-disk-encryption.js");
  results.push(await checkDiskEncryption());
  results.push(checkMemoryDirSafety());
  // A poisoned memory store is a delayed prompt-injection replayed into every recall;
  // fail-closed if a non-quarantined high-confidence injection is present or the scan
  // can't run. (Recall render paths already sanitize; this gates the store itself.)
  results.push(await checkMemoryInjection());
  // Self-playing loop liveness: fail if capture hooks were installed but have since
  // vanished from settings.json (capture silently off — a false green).
  results.push(await checkMemoryHooksLiveness());
  // Enforcement floor liveness: fail if kit was taught here but a PreToolUse gate
  // has vanished — the agent runs un-gated while kit still reads green. The floor
  // must prove it exists.
  results.push(await checkGateLiveness(root));
  // The git-hook floor: where it resolves to, and whether an installed gate can actually fail.
  results.push(await checkGitHookFloor(root));
  results.push(await checkDeviceIdOverride());
  // `[policy.agent_writes]` posture: an entry naming an op kit never asks about grants nothing while
  // still declaring the vendor — which refuses that vendor's real ops. Four documents claimed this
  // was surfaced; nothing called the function that computes it. Wired HERE, not in `runCheckGate`,
  // so `kit ci` and `kit heal` see it too.
  const { checkPolicyAgentWrites } = await import("./check-policy-ops.js");
  results.push(await checkPolicyAgentWrites(root));
  // What this run's directory covers. Run from a workspace root holding several repos side by
  // side, every manifest-dependent scanner skips truthfully and the summary read "All 25 checks
  // passed" — while the tree one level down had 30 known dependency vulnerabilities. The skips
  // were honest; the missing row was the one saying the code lives somewhere kit did not look.
  const { checkScanScope, scanScopeFacts, escalateManifestSkips } =
    await import("./check-nested-projects.js");
  const scope = await scanScopeFacts(root);
  results.push(await checkScanScope(root, scope));
  // Inbound integration: fold any third-party findings a partner tool emitted to
  // `.kit-scan-results.jsonl` into the verdict. No file → no-op. Can only escalate
  // (fail/warn), never green the gate — see external-findings.ts.
  const { checkExternalFindings } = await import("./external-findings.js");
  results.push(...(await checkExternalFindings(root)));

  // Attach a rule citation (CWE/OWASP) to each finding whose check is mapped in
  // the local rules catalog. Deterministic lookup, no network. Unmapped checks
  // pass through unchanged.
  // A manifest-absence skip is an honest not-applicable in a normal project and a coverage hole
  // when kit is standing in the wrong directory — same words, different meaning. Resolved here,
  // once, from the scope facts rather than by each scanner guessing, and applied last so it also
  // covers results appended after the scanners ran.
  return escalateManifestSkips(results, scope).map((r) => {
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
