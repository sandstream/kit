import { advisoryOptionsFor, checkDependencySurface } from "./check-dependency-surface.js";
import { auditDecision } from "./audit-exceptions.js";
import { skipsBasicScan } from "./basic-scan-skip.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import {
  LOCAL_COVER,
  scannedHead,
  staleCatalogDetail,
  staleCatalogStatus,
} from "./bumblebee-age.js";
import { checkEnvGitignored } from "./check-env-gitignore.js";
export { checkEnvGitignored } from "./check-env-gitignore.js";
import { resolveWorkspaceRoots } from "./workspaces.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { classifyGuardDog, guardDogScope, GUARDDOG_CHECK } from "./guarddog.js";
import { rescanArchiveRoots } from "./guarddog-archive-root.js";
import {
  buildSemgrepArgs,
  semgrepConfig,
  isAirGap,
  isLocalSemgrepConfig,
  PROVIDER_GLOB,
} from "./scanners.js";
import { findDockerfiles, findIacFiles } from "./check-iac-detect.js";
import { checkApkFloors } from "./check-apk-floors.js";
import type { AlpineSourceEvidence } from "./check-apk-sources.js";
import { checkMavenSbomCoverage } from "./maven-sbom.js";
import type { SecurityLevel } from "./check-projects.js";
import { ruleForCheck, type RuleRef } from "./rules/catalog.js";
import { hasOsvManifest } from "./osv-manifests.js";
import { unpinnedRequirements } from "./pinned-requirements.js";
import { TRIAGE_MAX_AGE_DAYS } from "./commands/triage.js";
import {
  ensureBumblebee,
  runScan,
  maxSeverity,
  isCatalogStale,
  BUMBLEBEE_VERSION,
  type BumblebeeFinding,
  type EnsureFailureKind,
  type ScanOutcome,
} from "./bumblebee.js";
import { describeTrivyFsResult } from "./check-trivy-text.js";
import { osvFinding } from "./osv-summary.js";
import { OSV_EXITS, readOsvReport } from "./osv-report.js";
import { readTrivyReport } from "./trivy-report.js";
import { readSemgrepReport } from "./semgrep-report.js";
import { npmAuditLockfile, runNpmAudit } from "./npm-audit-scope.js";
import { checkPipAudit } from "./check-pip-audit.js";
import {
  scannerEvidence,
  scannerGap,
  scannerObject,
  scannerRecord,
  type ScannerEvidenceStatus,
  type ScannerGap,
} from "./check-scanner-evidence.js";
import { checkTranscriptSecrets } from "./check-transcripts.js";
import { checkLicenses } from "./check-licenses.js";
import { checkBrowserScripts } from "./check-browser-scripts.js";
import { npmLockfileCover } from "./check-pinned-lockfile.js";
import { readRegularFileBytesIfPresent } from "./upstream-safe-read.js";
import {
  gitHistoryScope,
  readBasicSecretGrep,
  trufflehogHistoryGap,
  type BasicSecretMatch,
} from "./history-secret-evidence.js";
import { scanTrackedProviderSecrets, type ProviderSecretHit } from "./tracked-secret-shapes.js";

const exec = promisify(execFile);

function envFlagDisabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["0", "false", "off", "no"].includes(value.toLowerCase());
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "on", "yes"].includes(value.toLowerCase());
}

export function bumblebeeDownloadAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !envFlagEnabled(env.KIT_NO_DOWNLOAD) && !isAirGap(env);
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

/**
 * The renderable security categories, in display order.
 *
 * A LIST, not a bare union, because `printSecurityTable` renders by iterating it: a category that
 * exists in the type but not in the list is a row that gates the build and is never printed. That
 * is the false green in miniature, and deriving the type FROM the list makes it unrepresentable
 * rather than merely tested. `self-audit/*` is deliberately outside it — those results have their
 * own table.
 */
export const SECURITY_CATEGORIES = [
  "dependency",
  "exposure",
  "supply-chain",
  "secrets",
  "governance",
] as const;

export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number] | `self-audit/${string}`;

export interface SecurityCheckResult extends Partial<{ hasFindings: true; scanIncomplete: true }> {
  category: SecurityCategory;
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  severity?: "critical" | "high" | "medium" | "low";
  files?: string[]; // Files with issues (for secrets scan)
  suggestion?: string; // Installation or remediation instructions
  /** Vulnerable packages behind a dependency row (name and version, sanitised), for deployed-vs-branch tagging. */
  affected?: { name: string; version: string }[];
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
  evidenceStatus?: ScannerEvidenceStatus;
  evidenceSources?: AlpineSourceEvidence[];
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
  /** Other advisory ids (CVE/GHSA) the scanner reported for the same vulnerability. */
  aliases?: string[];
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
 *
 * A linked git worktree is the case that looked like "never installed" and is not: the
 * marker and the hooks live in the gitignored `.claude/`, so a worktree of a gated main
 * checkout has neither, and an agent working there runs ungated on the very machine where
 * the gates were installed. Worktree-per-task harnesses (T3 Code, Claude Code worktrees)
 * produce exactly that, so it fails like a lost gate rather than skipping.
 *
 * An agent session (`env`, see `agent-session.ts`) in a kit-managed checkout that never installed
 * the gates fails too: a fresh cloud clone otherwise runs every tool call ungated behind a skip.
 */
export async function checkGateLiveness(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecurityCheckResult> {
  const name = "enforcement gate liveness";
  const category = "exposure" as const;
  const { gateLiveness } = await import("./agent-config.js");
  const live = (await import("./gate-liveness-user.js")).withUserGates(gateLiveness(cwd));
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
    const { getCanonicalProjectRoot } = await import("./memory/canonical-root.js");
    const { getCurrentProjectRoot } = await import("./memory/project.js");
    const { gateMarkerPath } = await import("./agent-config.js");
    // Both come from git (forward slashes on Windows too); resolve() puts them in one form.
    const here = resolve(getCurrentProjectRoot(cwd));
    const main = resolve(getCanonicalProjectRoot(cwd));
    if (main !== here && existsSync(gateMarkerPath(main))) {
      return {
        category,
        name,
        status: "fail",
        severity: "high",
        detail: `this is a linked git worktree of ${main}: the gates are installed there, not here, so an agent working in this worktree runs ungated. Run: kit agent-config (in this worktree)`,
      };
    }
    const { ungatedSessionDetail } = await import("./agent-session.js");
    const session = ungatedSessionDetail(here, env);
    if (session) return { category, name, status: "fail", severity: "high", detail: session };
    return {
      category,
      name,
      status: "skip",
      detail: "enforcement gates not installed in this checkout",
    };
  }
  const { staleShellGateDetail } = await import("./gate-bash-matcher.js");
  const stale = staleShellGateDetail(cwd ?? process.cwd(), live);
  if (stale) return { category, name, status: "fail", severity: "high", detail: stale };
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
 * reviewer's gate permanently red. The warn names the one-command remediation
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
 * The result for an npm audit report with high or critical findings. A time-limited exception in
 * `audit-exceptions.json` (see audit-exceptions.ts) turns it into a pass only when it covers every
 * counted finding; otherwise it stays a failure, with the reason the file did not help.
 */
async function highFindingsResult(
  root: string,
  auditResult: unknown,
  high: number,
  critical: number,
  allowExceptions: boolean,
): Promise<SecurityCheckResult> {
  const counts = `${critical} critical, ${high} high vulnerabilities`;
  const { covered, note } = allowExceptions
    ? await auditDecision(root, auditResult)
    : { covered: false, note: "" };
  if (covered) {
    return {
      category: "dependency",
      name: "npm audit",
      status: "pass",
      detail: `${counts}, all covered by a time-limited exception (${note})`,
    };
  }
  return {
    category: "dependency",
    name: "npm audit",
    status: "fail",
    detail: note ? `${counts}; ${note}` : counts,
    severity: critical > 0 ? "critical" : "high",
  };
}

/**
 * Run npm audit and check for high/critical vulnerabilities
 */
export async function checkNpmAudit(root: string): Promise<SecurityCheckResult> {
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
  const hasNpmLock = npmAuditLockfile(root) !== undefined;
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

  const timeout = Number(process.env.KIT_NPM_AUDIT_TIMEOUT_MS ?? "") || 300_000;
  const { report, gap } = await runNpmAudit(root, timeout);
  const { high, critical } = report.metadata.vulnerabilities;
  const row: SecurityCheckResult =
    high + critical > 0
      ? await highFindingsResult(root, report, high, critical, !gap)
      : {
          category: "dependency",
          name: "npm audit",
          status: "pass",
          detail: "no high or critical findings in the npm audit report",
        };
  return scannerEvidence(row, report.count, gap);
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

export async function checkLockfilesCommitted(root: string): Promise<SecurityCheckResult[]> {
  const results: SecurityCheckResult[] = [];
  const present = (f: string): Promise<boolean> =>
    access(resolve(root, f))
      .then(() => true)
      .catch(() => false);

  // Resolve git-tracked state once — a non-git tree is a single honest warn, not a
  // per-ecosystem repeat.
  let gitOk = true;
  try {
    await exec("git", ["rev-parse", "--git-dir"], { timeout: 5_000, cwd: root });
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
      const { stdout } = await exec("git", ["ls-files", lf], { timeout: 5_000, cwd: root });
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
const EXACT_NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
      detail: "no install-script grant (only npm 12+ skips dependency install scripts by default)",
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
 * Check if dependencies use pinned versions. Says which manifests it read: with none, or
 * an unparseable package.json, there is nothing to vouch for, so it never claims "pinned".
 */
export async function checkPinnedVersions(root: string): Promise<SecurityCheckResult> {
  const unpinned: string[] = [];
  const checked: string[] = [];
  let staleLock: string | undefined;
  const result = (status: "pass" | "warn" | "skip", detail: string): SecurityCheckResult => ({
    category: "supply-chain",
    name: "pinned versions",
    status,
    detail,
    ...(status === "warn" ? { severity: "medium" as const } : {}),
  });

  const packageJsonContent = await readFile(resolve(root, "package.json"), "utf-8").catch(
    () => undefined,
  );
  if (packageJsonContent !== undefined) {
    let packageJson: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      packageJson = JSON.parse(packageJsonContent);
    } catch {
      return result("warn", "package.json could not be parsed — its pins were NOT checked");
    }
    const members = workspaceMemberNames(root);
    const isMember = (name: string) => members.has(name);
    const ranges = [
      ...unpinnedNodeDeps(packageJson.dependencies, isMember),
      ...unpinnedNodeDeps(packageJson.devDependencies, isMember),
    ];
    // A committed lockfile that matches package.json makes `npm ci` install exact versions,
    // so its ranges are pinned in effect. `[scan] strict_pins = true` turns this off.
    const cover = ranges.length ? await npmLockfileCover(root, packageJson) : {};
    if (cover.covered) {
      const s = ranges.length === 1 ? "" : "s";
      checked.push(
        `package.json: ${ranges.length} range${s} resolved by the committed ${cover.covered}`,
      );
    } else {
      unpinned.push(...ranges);
      checked.push("package.json");
      if (cover.reason) staleLock = cover.reason;
    }
  }

  const requirements = await readFile(resolve(root, "requirements.txt"), "utf-8").catch(
    () => undefined,
  );
  if (requirements !== undefined) {
    unpinned.push(...unpinnedRequirements(requirements));
    checked.push("requirements.txt");
  }

  if (unpinned.length > 0) {
    const note = staleLock ? ` (${staleLock})` : "";
    return result("warn", `${unpinned.length} unpinned dependencies${note}`);
  }
  if (checked.length === 0) return result("skip", "no package.json or requirements.txt to check");
  return result("pass", `all dependencies pinned (${checked.join(", ")})`);
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
function isPublicByDesign(
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
/**
 * SHA-256 of strings that are documentation samples, not credentials — honoured by BOTH the
 * trufflehog path (`isExampleCredential`) and the degraded basic scan (`basicSecretScanFiles`).
 *
 * A digest, deliberately, and not a path or file entry: it waves through exactly one known
 * string and nothing else in the file that contains it, and any edit to the string re-flags it.
 * `.kit-secretsignore` is the mechanism for accepting a *real* historical finding by commit;
 * this is for text that was never a secret in the first place.
 */
const DOC_SAMPLE_SECRET_DIGESTS = new Set([
  "868034cf6e8877d082cf2e61a4964c04affcbfd6abf8a8d0339ce3298636fa57",
  // CHANGELOG.md — the `[scan.client_exposed_allow]` example for the 6.9.0 bundle check. The
  // "value" is the English reason the variable is allowed, inside a ```toml block.
  "fe84d3b8aa71ba34eb2fc31c7c958bc961514b50eef8803748491cf06b8db8bc",
]);
const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;
const RESERVED_HOST_RE = /\.(internal|local|localdomain|localhost|test|invalid|example)$/i;
const EXAMPLE_DOMAIN_RE = /^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i;
/**
 * Matches a URI credential: a scheme, an optional user and secret in the userinfo position,
 * then host and optional port — the shape every URI-credential detector emits.
 *
 * Described in prose rather than shown as a literal on purpose. A literal example of that
 * shape in a comment is itself matched by kit's own staged-secret scan, so it blocked every
 * commit touching this file until the author reached for `--no-verify`. Please do not
 * "improve" this back into an inline example.
 */
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
) {
  return classifyTrufflehogReport(stdout, readFile, ignores).counts;
}

function classifyTrufflehogReport(
  stdout: string,
  readFile: (path: string) => string | null,
  ignores: SecretsIgnoreEntry[],
) {
  const counts = { verified: 0, unverified: 0, publicByDesign: 0, example: 0, ignored: 0 };
  let malformed = false;
  const lines = stdout === "" ? [] : stdout.replace(/\r?\n$/, "").split(/\r?\n/);
  for (const line of lines) {
    const record = scannerObject(line);
    if (!record || typeof record.DetectorName !== "string" || !record.DetectorName.trim()) {
      malformed = true;
      if (line.includes('"DetectorName"')) counts.unverified++;
      continue;
    }
    const { finding, valid } = readTrufflehogFinding(record, record.DetectorName);
    if (!valid) malformed = true;
    const classification = classifyTrufflehogFinding(finding, readFile, ignores);
    counts[classification]++;
  }
  return { counts, malformed };
}

function readTrufflehogFinding(record: Record<string, unknown>, detector: string) {
  const metadata = scannerRecord(record.SourceMetadata) ? record.SourceMetadata : undefined;
  const data = scannerRecord(metadata?.Data) ? metadata.Data : undefined;
  const git = scannerRecord(data?.Git) ? data.Git : undefined;
  const file = typeof git?.file === "string" ? git.file : undefined;
  const commit = typeof git?.commit === "string" ? git.commit : undefined;
  const finding: TrufflehogFinding = {
    verified: record.Verified === true,
    raw: typeof record.Raw === "string" ? record.Raw : "",
    detector,
    file,
    commit,
  };
  const valid =
    typeof record.Verified === "boolean" &&
    typeof record.Raw === "string" &&
    git !== undefined &&
    file === git.file &&
    commit === git.commit;
  return { finding, valid };
}

function classifyTrufflehogFinding(
  finding: TrufflehogFinding,
  readFile: (path: string) => string | null,
  ignores: SecretsIgnoreEntry[],
): "verified" | "unverified" | "publicByDesign" | "example" | "ignored" {
  if (finding.verified) return "verified";
  try {
    if (isPublicByDesign(finding, readFile)) return "publicByDesign";
    if (isExampleCredential(finding)) return "example";
    if (isIgnoredFinding(finding, ignores)) return "ignored";
  } catch {
    // A finding with unreadable context still needs review.
  }
  return "unverified";
}

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
  const matches = lines.flatMap((line) => {
    const match = line.match(/^([^:]+):\d+:(.*)$/);
    return match ? [{ file: match[1], content: match[2] }] : [];
  });
  return basicSecretFiles(matches);
}

function basicSecretFiles(matches: BasicSecretMatch[]): string[] {
  const VALUE_RE =
    /(?:api[_-]?key|secret[_-]?key|password|token|credential)["']?\s*[:=]\s*["']([^"']{20,})/i;
  const TEMPLATE_VALUE =
    /^\s*(\$\{\{[^}]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_:.-]*\}|\{\{[^}]*\}\}|\$\([^)]*\))\s*$/;
  const files = new Set<string>();
  for (const { file, content } of matches) {
    if (skipsBasicScan(file, content)) continue;
    const value = content.match(VALUE_RE)?.[1] ?? "";
    if (/^[A-Z][A-Z0-9_]+$/.test(value)) continue; // env-var name, not a secret
    if (TEMPLATE_VALUE.test(value)) continue; // substitution syntax, not a literal
    // A known documentation sample. The trufflehog path already skips these via
    // `isExampleCredential`; without the same check here the degraded path warns forever on
    // text that is not a secret, and `.kit-secretsignore` cannot clear it because that file
    // names findings by commit+detector, neither of which a working-tree grep has. A warning
    // with no reachable green state is one nobody reads (README).
    if (DOC_SAMPLE_SECRET_DIGESTS.has(createHash("sha256").update(value.trim()).digest("hex"))) {
      continue;
    }
    files.add(file);
  }
  return [...files];
}

const HISTORY_SECRET_SCAN = { category: "secrets", name: "secrets scan" } as const;
const NO_HISTORY_SECRET_SCOPE = {
  ...HISTORY_SECRET_SCAN,
  status: "skip",
  evidenceStatus: "missing",
  detail: "no committed content in local Git history",
} as const;

async function checkBasicSecretScan(
  root: string,
  hasHistory: boolean,
  scopeLimit?: ScannerGap,
): Promise<SecurityCheckResult> {
  const process = await execFileNoThrow(
    "git",
    [
      "grep",
      "--no-color",
      "--no-column",
      "--no-textconv",
      "--no-recurse-submodules",
      "--full-name",
      "-H",
      "-I",
      "-n",
      "-z",
      "-iE",
      "-e",
      "(api[_-]?key|secret[_-]?key|password|token|credential)[\"']?[[:space:]]*[:=][[:space:]]*[\"'][^\"']{20,}",
      "--",
    ],
    { timeout: 10_000, cwd: root },
  );
  const { matches, gap: grepGap } = readBasicSecretGrep(process);
  const provider = await scanTrackedProviderSecrets(root);
  const gap = grepGap ?? provider.gap;
  const files = [...new Set([...provider.hits.map((h) => h.file), ...basicSecretFiles(matches)])];
  if (!gap && !scopeLimit && !hasHistory && files.length === 0) return NO_HISTORY_SECRET_SCOPE;

  const limitation =
    "the Git grep fallback covers tracked working-tree text only. Install TruffleHog to scan Git history";
  const detail = basicScanDetail(files.length, matches.length, provider.hits);
  return scannerEvidence(
    {
      ...HISTORY_SECRET_SCAN,
      // A provider-shaped key is the shape scan-staged blocks at commit time, so it fails here too.
      status: provider.hits.length ? "fail" : "warn",
      severity: provider.hits.length ? "high" : "medium",
      detail,
      ...(files.length ? { files } : {}),
    },
    files.length,
    mergeHistoryLimits(
      gap
        ? { ...gap, reason: `${gap.reason}. TruffleHog is unavailable for Git history` }
        : hasHistory
          ? { status: "partial", reason: files.length ? limitation : `${detail}. ${limitation}` }
          : undefined,
      scopeLimit,
    ),
  );
}

function basicScanDetail(files: number, matches: number, provider: ProviderSecretHit[]): string {
  if (provider.length) {
    const list = provider.map((h) => `${h.file} (${h.labels.join(", ")})`).join("; ");
    const others = files - provider.length;
    const rest = others > 0 ? `, and ${others} other file(s) with unverified matches` : "";
    return `${provider.length} tracked file(s) with provider-shaped keys that kit's secret patterns match: ${list}${rest}`;
  }
  if (files) return `${files} file(s) with unverified secret-shaped strings in the working tree`;
  return matches
    ? "all Git grep matches were excluded by the basic scan filters"
    : "Git grep found no matches";
}

function mergeHistoryLimits(gap?: ScannerGap, scopeLimit?: ScannerGap): ScannerGap | undefined {
  return gap && scopeLimit
    ? { ...gap, reason: `${gap.reason}. ${scopeLimit.reason}` }
    : (gap ?? scopeLimit);
}

function historyScopeWarning(gap: ScannerGap): SecurityCheckResult {
  return scannerEvidence({ ...HISTORY_SECRET_SCAN, status: "warn", detail: "" }, 0, gap);
}

export async function checkSecretsInCode(root: string): Promise<SecurityCheckResult> {
  const scope = await gitHistoryScope(root);
  if (scope.kind === "outside") {
    return {
      ...HISTORY_SECRET_SCAN,
      status: "skip",
      evidenceStatus: "missing",
      detail: "not a git repository",
    };
  }
  if (scope.kind === "unknown") return historyScopeWarning(scope.gap);

  const trufflehogBin = await resolveToolBin("trufflehog");
  if (!trufflehogBin) return checkBasicSecretScan(root, scope.hasContent, scope.limit);
  if (!scope.hasContent)
    return scope.limit ? historyScopeWarning(scope.limit) : NO_HISTORY_SECRET_SCOPE;

  const scan = await execFileNoThrow(
    trufflehogBin,
    [
      "git",
      pathToFileURL(root).href,
      "--json",
      "--no-update",
      "--log-level=2",
      "--no-ignore-tag",
      "--fail",
      "--fail-on-scan-errors",
    ],
    { timeout: 90_000, cwd: root },
  );

  const readWorktreeFile = (path: string): string | null => {
    try {
      return readFileSync(resolve(root, path), "utf8");
    } catch {
      return null;
    }
  };
  const ignores = parseSecretsIgnore(readWorktreeFile(".kit-secretsignore") ?? "");
  const { counts, malformed } = classifyTrufflehogReport(scan.stdout, readWorktreeFile, ignores);
  const { verified, unverified, publicByDesign, example, ignored } = counts;
  const gap = mergeHistoryLimits(
    trufflehogHistoryGap(scan, {
      verified,
      unverified: unverified + publicByDesign + example + ignored,
      malformed,
    }),
    scope.limit,
  );
  return describeTrufflehogResult(counts, gap);
}

function describeTrufflehogResult(
  counts: ReturnType<typeof classifyTrufflehogFindings>,
  gap?: ScannerGap,
): SecurityCheckResult {
  const { verified, unverified, publicByDesign, example, ignored } = counts;
  const total = verified + unverified + publicByDesign + example + ignored;
  const notes = [
    publicByDesign > 0
      ? `${publicByDesign} public-by-design client key(s) (Firebase web config / DSN). Check API-key restrictions and security rules.`
      : "",
    example > 0 ? `${example} example credential(s) in fixtures or documentation.` : "",
    ignored > 0 ? `${ignored} accepted historical finding(s) via .kit-secretsignore.` : "",
  ].filter(Boolean);
  const row: SecurityCheckResult = { ...HISTORY_SECRET_SCAN, status: "pass", detail: "" };
  if (verified > 0) {
    row.status = "fail";
    row.severity = "critical";
    row.detail = `${verified} VERIFIED-LIVE secret(s) in history reachable from local Git refs. Rotate them now`;
  } else if (unverified > 0) {
    row.status = "warn";
    row.severity = "medium";
    row.detail = `${unverified} unverified secret-shaped string(s) in history reachable from local Git refs (0 verified-live). Review the findings`;
  } else if (gap) {
    row.severity = "medium";
    row.detail = "TruffleHog reported findings before coverage could be confirmed";
  } else {
    row.detail =
      "no actionable committed secrets (TruffleHog detectors, history reachable from local Git refs)";
  }
  const result = scannerEvidence(row, total, gap);
  return notes.length ? { ...result, detail: `${result.detail}. ${notes.join(" ")}` } : result;
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
    detail: `Socket is cloud-only (uploads manifest; no offline/air-gap), excluded from kit's local-first check. ${LOCAL_COVER}`,
  };
}

/** GuardDog verification fetches dependency artifacts from the public registry. */
export async function checkGuardDog(root: string): Promise<SecurityCheckResult> {
  const base = GUARDDOG_CHECK;
  const envEnabled = ["1", "true", "yes", "on"].includes(
    (process.env.KIT_GUARDDOG ?? "").trim().toLowerCase(),
  );
  // A project can opt in through .kit.toml or the environment.
  let cfgEnabled = false;
  try {
    const { loadConfig } = await import("./config.js");
    const cfg = await loadConfig(resolve(root, ".kit.toml"));
    cfgEnabled = cfg.scan?.guarddog === true;
  } catch {
    // The environment controls opt-in if the config cannot be read.
  }
  if (!envEnabled && !cfgEnabled) {
    return {
      ...base,
      status: "skip",
      detail:
        "opt-in. Set `guarddog = true` under [scan] in .kit.toml or set KIT_GUARDDOG=1 to run local malware heuristics",
    };
  }

  const candidates = [
    { ecosystem: "npm", file: "package.json" },
    { ecosystem: "pypi", file: "requirements.txt" },
  ] as const;
  let target: ((typeof candidates)[number] & { manifest: Buffer }) | undefined;
  for (const candidate of candidates) {
    try {
      const manifest = readRegularFileBytesIfPresent(resolve(root, candidate.file));
      if (!manifest) continue;
      target = { ...candidate, manifest };
      break;
    } catch {
      return scannerEvidence({ ...base, status: "warn", detail: "" }, 0, {
        status: "unavailable",
        reason: `kit could not read the GuardDog target ${candidate.file}`,
        didNotStart: true,
      });
    }
  }
  if (!target) {
    return { ...base, status: "skip", detail: "no package.json / requirements.txt to scan" };
  }
  const { manifest, ecosystem, file } = target;
  const scope = guardDogScope(ecosystem, manifest);
  if (scope.gap === "malformed") {
    return scannerEvidence({ ...base, status: "warn", detail: "" }, 0, {
      status: "malformed",
      reason: `GuardDog target ${file} is malformed`,
      didNotStart: true,
    });
  }

  const bin = await resolveToolBin("guarddog");
  if (!bin) {
    return {
      ...base,
      status: "warn",
      detail: "guarddog not installed. Malware heuristics are unavailable",
      severity: "medium",
      suggestion: "mise use pipx:guarddog",
      didNotRun: true,
      evidenceStatus: "unavailable",
    };
  }

  // A verify report gives registry versions but no artifact or ruleset identity.
  // A fresh scan is required even if a previous verdict covered these selectors.
  const timeoutMs = Number(process.env.KIT_GUARDDOG_TIMEOUT_MS ?? "") || 300_000;
  const verify = await execFileNoThrow(bin, [ecosystem, "verify", file, "--output-format=json"], {
    timeout: timeoutMs,
    cwd: root,
    // Older GuardDog includes devDependencies by default. Newer versions use this setting.
    env: { ...process.env, GUARDDOG_NPM_INCLUDE_DEV_DEPENDENCIES: "true" },
  });
  const result = await rescanArchiveRoots(ecosystem, verify, bin, timeoutMs);
  let manifestChanged = true;
  try {
    const currentManifest = readRegularFileBytesIfPresent(resolve(root, file));
    manifestChanged = !currentManifest || !manifest.equals(currentManifest);
  } catch {
    // An unreadable target cannot confirm the original scan scope.
  }
  return classifyGuardDog(result, scope, manifestChanged);
}

/**
 * Scan Dockerfile and filesystem for CVEs using Trivy.
 * Catches OS-level vulnerabilities that npm audit misses.
 */
async function checkTrivy(root: string): Promise<SecurityCheckResult> {
  // `trivy fs .` reads the whole tree, so a Dockerfile in `app/` counts as much as one at the root
  // (the same bounded discovery `trivy config` uses).
  if ((await findDockerfiles(root)).length === 0) {
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "skip",
      detail: "no Dockerfile found in this tree (three levels)",
    };
  }

  // Resolve mise-first (like socket/semgrep): a mise-installed trivy isn't on kit's PATH.
  const trivyBin = await resolveToolBin("trivy");
  if (!trivyBin) {
    return {
      category: "supply-chain",
      name: "trivy container scan",
      status: "warn",
      detail: "trivy not installed, so vulnerabilities in the project files are undetected",
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

  const report = readTrivyReport(result.stdout, "vulnerability");
  const row: SecurityCheckResult = {
    category: "supply-chain",
    name: "trivy container scan",
    ...describeTrivyFsResult(report.count),
  };
  return scannerEvidence(row, report.count, scannerGap(report, result));
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
  const iac = await findIacFiles(cwd);
  const hasIaC = iac.length > 0;
  if (!hasIaC) {
    return {
      category: "supply-chain",
      name,
      status: "skip",
      detail: "no Dockerfile/Compose/Terraform found in this tree (three levels)",
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
    [
      "config",
      ".",
      "--skip-dirs",
      PROVIDER_GLOB,
      "--format",
      "json",
      "--severity",
      "HIGH,CRITICAL",
      "--quiet",
    ],
    { timeout: 120_000, cwd: root },
  );
  const report = readTrivyReport(result.stdout, "configuration", iac);
  const { count } = report;
  const row: SecurityCheckResult =
    count > 0
      ? {
          category: "supply-chain",
          name,
          status: "warn",
          detail: `${count} high/critical IaC misconfiguration(s) -run: trivy config .`,
          severity: "high",
        }
      : {
          category: "supply-chain",
          name,
          status: "pass",
          detail: "no high/critical IaC misconfigurations in Trivy reported targets",
        };
  return scannerEvidence(row, count, scannerGap(report, result));
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
  const report = readTrivyReport(result.stdout, kind);
  const { count } = report;
  const row: SecurityCheckResult =
    count > 0
      ? {
          category: "dependency",
          name,
          status: "fail",
          detail: `${count} high/critical JVM dependency CVE(s) -run: trivy fs --offline-scan ${mavenDir}`,
          severity: "high",
        }
      : {
          category: "dependency",
          name,
          status: "pass",
          detail: "no high/critical JVM dependency CVEs",
        };
  return scannerEvidence(row, count, scannerGap(report, result));
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
  const osvEcosystemPresent = (): Promise<boolean> => hasOsvManifest(root);
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
  const report = readOsvReport(result.stdout);
  const gap = scannerGap(report, result, OSV_EXITS);
  if (gap && report.count === 0 && !(await osvEcosystemPresent()))
    return {
      category: "supply-chain",
      name,
      status: "skip",
      detail: "no applicable manifests for OSV",
      evidenceStatus: gap.status,
    };
  const row: SecurityCheckResult =
    report.count > 0
      ? osvFinding(name, report)
      : {
          category: "supply-chain",
          name,
          status: "pass",
          detail: "no known dependency vulnerabilities",
        };
  return scannerEvidence(row, report.count, gap);
}

export { checkLicenses };

/**
 * Run static analysis using Semgrep to catch security anti-patterns in source code.
 */
const SEMGREP_NAME = "semgrep SAST";

function semgrepNotConfigured(): SecurityCheckResult {
  return {
    category: "supply-chain",
    name: SEMGREP_NAME,
    status: "skip",
    detail:
      "SAST opt-in: set KIT_SEMGREP_CONFIG (e.g. p/default, or a local ruleset path) to enable",
  };
}

function semgrepUnavailable(): SecurityCheckResult {
  return {
    category: "supply-chain",
    name: SEMGREP_NAME,
    status: "warn",
    detail:
      "KIT_SEMGREP_CONFIG is set (SAST opted in) but semgrep is not installed — SAST did NOT run (mise use pipx:semgrep, or brew install semgrep)",
    severity: "medium",
    didNotRun: true,
  };
}

function semgrepAirGapRefusal(config: string): SecurityCheckResult {
  return {
    category: "supply-chain",
    name: SEMGREP_NAME,
    status: "skip",
    detail: `air-gap: refusing registry semgrep config '${config}' (would egress) — set KIT_SEMGREP_CONFIG to a local ruleset path`,
  };
}

async function checkSemgrep(root: string): Promise<SecurityCheckResult> {
  // SAST is opt-in. Once requested, a missing scanner is an unscanned warning,
  // while air-gap mode refuses registry rules before spawning the process.
  if (!process.env.KIT_SEMGREP_CONFIG?.trim()) return semgrepNotConfigured();
  const semgrepBin = await resolveToolBin("semgrep");
  if (!semgrepBin) return semgrepUnavailable();

  const config = semgrepConfig(process.env);
  if (isAirGap(process.env) && !isLocalSemgrepConfig(config)) {
    return semgrepAirGapRefusal(config);
  }
  const result = await execFileNoThrow(semgrepBin, buildSemgrepArgs({ mode: "json", config }), {
    timeout: 120_000,
    cwd: root,
  });
  const report = readSemgrepReport(result.stdout);
  const { count, blocking, scanned } = report;
  const row: SecurityCheckResult =
    count > 0
      ? {
          category: "supply-chain",
          name: SEMGREP_NAME,
          status: blocking ? "fail" : "warn",
          detail: `${count} security finding(s). Run semgrep scan --config ${config}`,
          severity: blocking ? "high" : "medium",
        }
      : {
          category: "supply-chain",
          name: SEMGREP_NAME,
          status: "pass",
          detail: `Semgrep reported ${scanned} scanned file(s) and no findings at warning severity or higher`,
        };
  // This command omits --error, so only exit zero can establish coverage.
  return scannerEvidence(row, count, scannerGap(report, result));
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
const BUMBLEBEE_NAME = "bumblebee (supply-chain)";

interface BumblebeeCheckContext {
  required: boolean;
  unscanned: "fail" | "warn";
}

function bumblebeeContext(): BumblebeeCheckContext {
  const required = envFlagEnabled(process.env.KIT_BUMBLEBEE_REQUIRED);
  return { required, unscanned: required ? "fail" : "warn" };
}

function bumblebeeInstallFailure(
  context: BumblebeeCheckContext,
  reason: string | undefined,
  kind: EnsureFailureKind | undefined,
): SecurityCheckResult {
  if (kind === "integrity") {
    return {
      category: "supply-chain",
      name: BUMBLEBEE_NAME,
      status: "fail",
      evidenceStatus: "malformed",
      detail: `scanner ${reason}`,
      severity: "high",
      suggestion:
        "The downloaded scanner did not match its pinned checksum. Do NOT trust it. Investigate for tampering (network MITM, compromised mirror), clear ~/.kit/tools/bumblebee, and retry from a trusted network.",
    };
  }
  return {
    category: "supply-chain",
    name: BUMBLEBEE_NAME,
    status: context.unscanned,
    evidenceStatus: kind === "unsupported" ? "unsupported" : "unavailable",
    ...(context.required || kind === "config" ? { didNotRun: true } : {}),
    detail: `scanner unavailable: ${reason}${context.required ? " (KIT_BUMBLEBEE_REQUIRED — cannot ship unscanned)" : ""}`,
    severity: context.required ? "high" : "low",
    suggestion:
      "Provide a binary with KIT_BUMBLEBEE_BIN, or allow downloads (unset KIT_NO_DOWNLOAD). Manual install: go install github.com/perplexityai/bumblebee/cmd/bumblebee@latest",
  };
}

async function bumblebeeFindingsVerdict(
  outcome: ScanOutcome,
  profile: string,
  root: string,
): Promise<SecurityCheckResult | null> {
  if (outcome.findings.length === 0) return null;
  // Persist matches under the governed root. Logging failure never hides the scanner verdict.
  await logSupplyChainFindings(outcome.findings, profile, root).catch(() => {});
  return {
    category: "supply-chain",
    name: BUMBLEBEE_NAME,
    status: "fail",
    detail: `${outcome.findings.length} known supply-chain exposure(s): ${describeFindings(outcome.findings)}`,
    severity: toResultSeverity(maxSeverity(outcome.findings)),
    files: Array.from(new Set(outcome.findings.map((f) => f.sourceFile).filter(Boolean))),
    suggestion:
      "Remove or downgrade the flagged packages immediately — they match curated known-compromise catalogs. Verify on the source advisory before trusting any replacement.",
  };
}

export function bumblebeeStaleCatalogVerdict(
  outcome: ScanOutcome,
  ageDays: number,
  update: { latest: string; pinned: string } | null,
  profile = "baseline",
): SecurityCheckResult {
  const suggestion = update
    ? `bumblebee ${update.latest} is available (pinned ${update.pinned}). Moving BUMBLEBEE_VERSION + TARBALL_CHECKSUMS together in src/bumblebee.ts is the only way to change the bundled catalogs — compare the release tarball's threat_intel/ to see what it actually adds.`
    : "No newer bumblebee release is known here (the check is cached, suppressed, or upstream has published none), so this age may be upstream's own rather than a lagging pin.";
  return {
    category: "supply-chain",
    name: BUMBLEBEE_NAME,
    status: staleCatalogStatus(ageDays),
    evidenceStatus: "stale",
    detail: staleCatalogDetail(outcome.packagesScanned, ageDays, update, profile),
    suggestion,
    ...(update && {
      advisory: {
        key: `bumblebee-catalogs-stale:${update.latest}`,
        title: `bumblebee ${update.latest} available (pinned ${update.pinned}, catalogs ${ageDays}d old)`,
        detail: suggestion,
      },
    }),
  };
}

async function bumblebeeCatalogAdvisory(
  outcome: ScanOutcome,
  profile: string,
): Promise<SecurityCheckResult | null> {
  if (outcome.catalogMtime === undefined) return null;
  const { stale, ageDays } = isCatalogStale(outcome.catalogMtime, Date.now());
  if (!stale) return null;
  // Cached-only lookup keeps the security verdict independent of network availability.
  const { readCachedBumblebeeUpdateSync } = await import("./bumblebee-update.js");
  const update = readCachedBumblebeeUpdateSync(BUMBLEBEE_VERSION);
  return bumblebeeStaleCatalogVerdict(outcome, ageDays, update, profile);
}

async function checkBumblebee(root: string): Promise<SecurityCheckResult> {
  const context = bumblebeeContext();
  if (envFlagDisabled(process.env.KIT_BUMBLEBEE)) {
    if (context.required)
      return bumblebeeInstallFailure(context, "required scanner is disabled", "config");
    return {
      category: "supply-chain",
      name: BUMBLEBEE_NAME,
      status: "skip",
      detail: "disabled via KIT_BUMBLEBEE",
    };
  }
  const ensured = await ensureBumblebee({
    allowDownload: bumblebeeDownloadAllowed(process.env),
  });
  if (!ensured.install) return bumblebeeInstallFailure(context, ensured.reason, ensured.kind);

  const profile = process.env.KIT_BUMBLEBEE_PROFILE || "baseline";
  const roots = (process.env.KIT_BUMBLEBEE_ROOTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const outcome = await runScan({ install: ensured.install, profile, roots, cwd: root });
  const findings = await bumblebeeFindingsVerdict(outcome, profile, root);
  const row =
    findings ??
    ({
      category: "supply-chain",
      name: BUMBLEBEE_NAME,
      status: outcome.gap ? context.unscanned : "pass",
      detail: scannedHead(outcome.packagesScanned, profile),
    } satisfies SecurityCheckResult);
  if (!findings && !outcome.gap) {
    const advisory = await bumblebeeCatalogAdvisory(outcome, profile);
    if (advisory) return advisory;
  }
  return scannerEvidence(row, outcome.findings.length, outcome.gap);
}

/** Short, human-readable summary of the catalogs matched by findings. */
function describeFindings(findings: BumblebeeFinding[]): string {
  const labels = Array.from(
    new Set(findings.map((f) => f.catalogName || f.catalogId).filter(Boolean)),
  );
  const shown = labels.slice(0, 3).join("; ");
  return labels.length > 3 ? `${shown}; +${labels.length - 3} more` : shown;
}

async function runPrimarySecurityChecks(
  root: string,
  level: SecurityLevel = "all",
): Promise<SecurityCheckResult[]> {
  const { checkCodeGuardrails } = await import("./check-code-guardrails.js");
  // Started only when asked for, so a project run does not scan git history again.
  const repo =
    level === "project"
      ? []
      : [checkEnvGitignored(root), checkSecretsInCode(root), checkSocket(), checkBumblebee(root)];
  if (level !== "project") repo.push(checkSemgrep(root));
  const project =
    level === "repo"
      ? []
      : [
          checkNpmAudit(root),
          checkPipAudit(root),
          checkPinnedVersions(root),
          checkTrivy(root),
          checkApkFloors(root),
          checkLicenses(root),
          checkBrowserScripts(root),
          checkTrivyConfig(root),
          checkOsvScanner(root),
          checkMavenAudit(root),
          checkMavenSbomCoverage(root),
          checkGuardDog(root),
          checkAllowScripts(root),
        ];
  const lockfileResults = level === "repo" ? [] : await checkLockfilesCommitted(root);
  const codeResults = level === "repo" ? [] : await checkCodeGuardrails(root);
  const surfaceResults =
    level === "repo" ? [] : await checkDependencySurface(root, await advisoryOptionsFor(root));
  return [
    ...(await Promise.all([...project, ...repo])),
    ...lockfileResults,
    ...codeResults,
    ...surfaceResults,
  ];
}
async function appendHostSecurityChecks(
  results: SecurityCheckResult[],
  root: string,
): Promise<void> {
  results.push(...(await checkServiceExposure()));
  results.push(...(await (await import("./check-ai-devservers.js")).checkAiDevServers()));
  const { checkDiskEncryption, checkMemoryDirSafety } = await import("./check-disk-encryption.js");
  results.push(await checkDiskEncryption(), checkMemoryDirSafety());
  results.push(await checkMemoryInjection(), await checkMemoryHooksLiveness());
  results.push(await checkTranscriptSecrets(undefined, root));
  results.push(await checkGateLiveness(root), await checkGitHookFloor(root));
  results.push(await (await import("./check-deny-rules.js")).checkKitDenyRules(root));
  results.push(await checkDeviceIdOverride());
  results.push(await (await import("./check-docker-ioc.js")).checkDockerIocs());
}

async function loadGovernedConfig(root: string): Promise<import("./config.js").kitConfig | null> {
  try {
    const { loadConfig } = await import("./config.js");
    return await loadConfig(resolve(root, ".kit.toml"));
  } catch {
    return null;
  }
}

async function appendProjectSecurityChecks(
  results: SecurityCheckResult[],
  root: string,
): Promise<SecurityCheckResult[]> {
  const { checkPolicyAgentWrites } = await import("./check-policy-ops.js");
  results.push(await checkPolicyAgentWrites(root));
  const { checkScanScope, scanScopeFacts, escalateManifestSkips } =
    await import("./check-nested-projects.js");
  const scope = await scanScopeFacts(root);
  results.push(await checkScanScope(root, scope));
  const { checkAdvisoryBaseline } = await import("./check-advisory-baseline.js");
  results.push(await checkAdvisoryBaseline(root));
  const governed = await loadGovernedConfig(root);
  const { checkExposureSet } = await import("./check-exposure-set.js");
  results.push(...(await checkExposureSet(root, governed)));
  const { checkEnforcementEvidence } = await import("./check-enforcement-evidence.js");
  results.push(await checkEnforcementEvidence(root));
  const { checkDecisionLedger } = await import("./check-decision-ledger.js");
  results.push(await checkDecisionLedger(root, governed?.decisions?.require === true));
  const { checkExternalFindings } = await import("./external-findings.js");
  results.push(...(await checkExternalFindings(root)));
  const { checkAgentConfig } = await import("./check-agent-config.js");
  results.push(...(await checkAgentConfig(root)));
  results.push(...(await (await import("./check-gha-audit.js")).checkGhaWorkflows(root)));
  results.push(...(await import("./check-own-lifecycle-hook.js")).checkOwnLifecycleHook(root));
  return escalateManifestSkips(results, scope);
}

function attachRuleCitations(results: SecurityCheckResult[]): SecurityCheckResult[] {
  return results.map((r) => {
    const rule = ruleForCheck(r.name);
    return rule ? { ...r, rule } : r;
  });
}

/**
 * Run all security checks against the governed root. Every filesystem read and scanner spawn
 * receives this root; callers may therefore audit another project without changing process cwd.
 */
export async function checkSecurity(
  cwd?: string,
  level: SecurityLevel = "all",
): Promise<SecurityCheckResult[]> {
  const root = cwd ?? process.cwd();
  const results = await runPrimarySecurityChecks(root, level);
  if (level === "project") return attachRuleCitations(results);
  await appendHostSecurityChecks(results, root);
  return attachRuleCitations(await appendProjectSecurityChecks(results, root));
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
