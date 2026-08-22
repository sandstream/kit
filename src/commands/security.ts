/**
 * `kit security` command cluster — extracted from cli.ts (5.0-alpha god-module split).
 *
 * `cmdSecurity` is the single top-level entry (registered in the COMMANDS dispatch
 * table in cli.ts); it routes `kit security <sub>` to the module-private handlers
 * below via process.argv[3]. Subcommands: policy [init|add|check], scan-staged,
 * scan-build, scan-transcripts, costs, check-gitignore, verify-pull, prescan,
 * prescan-diff, clear-cache.
 *
 * Self-contained lift: every dependency is a sibling core module — no cli.ts-local
 * helpers, no cross-cluster cmd* calls. Mirrors the scan.ts/triage.ts/audit.ts pattern.
 */
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { isNonInteractive } from "../environment.js";
import { promptConfirm } from "../utils/prompt.js";
import {
  initAllowlist,
  checkAllowlist,
  addToAllowlist,
  checkSecretPolicy,
} from "../security-policy.js";
import { clearBumblebeeCache } from "../bumblebee.js";
import { scanStagedFiles } from "../scan-staged.js";
import { existsSync } from "node:fs";
import { scanBuildArtifacts } from "../scan-build.js";
import { SECRET_SHAPE_COUNT } from "../utils/redactSecrets.js";
import { scanTranscripts } from "../scan-transcripts.js";
import { sampleCosts } from "../cost-monitor.js";
import { checkGitignore, patchGitignore, findCommittedSensitive } from "../check-gitignore.js";
import { auditPull, reportSeverity } from "../post-pull-audit.js";

async function cmdSecurityPrescan(): Promise<boolean> {
  const root = process.argv[4];
  if (!root) {
    console.error(
      `${c.red}Usage: kit security prescan <path> [--deep] [--exclude=<substr>,<substr>] [--only=<check>,<check>] [--skip=<check>,<check>] [--vs-baseline=<path.jsonl>] [--format=text|json]${c.reset}`,
    );
    console.error(
      `${c.dim}Example: kit security prescan ~/projects --deep --exclude=convex-backend,sentry-self-hosted${c.reset}`,
    );
    return false;
  }
  const deep = hasFlag(process.argv, "--deep");
  // Comma lists via flagValue so `--only a,b` works as well as `--only=a,b`. These read only the
  // `=` spelling before, which made the conventional space form a silently ignored flag: the token
  // after it is not `--`-prefixed, so `unknownFlags` skips it too and nothing complains.
  const commaList = (name: string): string[] | undefined => {
    const raw = flagValue(process.argv, name);
    if (raw === undefined) return undefined;
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };
  const exclude = commaList("--exclude") ?? [];
  const onlyChecks = commaList("--only");
  const skipChecks = commaList("--skip");
  const formatArg = flagValue(process.argv, "--format");
  const format: "text" | "json" = formatArg === "json" ? "json" : "text";
  // --vs-baseline=<path> turns prescan into a drift-detector: run once,
  // diff against a baseline JSONL, output ONLY new regressions, exit 1 if any.
  // Designed for cron / systemd-timer / GitHub Actions schedule.
  const vsBaseline = flagValue(process.argv, "--vs-baseline");
  const { runPrescan } = await import("../security-prescan.js");

  if (format === "text") {
    console.log(`${c.bold}${c.cyan}kit security prescan${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
    console.log(`  ${c.dim}root:${c.reset} ${root}`);
    console.log(
      `  ${c.dim}mode:${c.reset} ${deep ? "deep (default + CVE + workflow-drift + audit-gap + bumblebee)" : "default-bundle"}`,
    );
    if (exclude.length) console.log(`  ${c.dim}exclude:${c.reset} ${exclude.join(", ")}`);
    console.log();
  }

  const startMs = Date.now();
  const report = await runPrescan({
    root: resolve(root),
    deep,
    exclude,
    onlyChecks,
    skipChecks,
  });
  const durSec = Math.round((Date.now() - startMs) / 1000);

  // --vs-baseline drift mode: diff current report against baseline JSONL,
  // emit ONLY added (regressions). Cron-friendly: exit 1 on regression.
  if (vsBaseline) {
    const { loadReport, diffReports } = await import("../security-prescan.js");
    const baseline = await loadReport(vsBaseline);
    const diff = diffReports(baseline, report);
    if (format === "json") {
      process.stdout.write(
        JSON.stringify(
          {
            baseline: vsBaseline,
            addedCount: diff.added.length,
            removedCount: diff.removed.length,
            unchangedCount: diff.unchanged.length,
            added: diff.added,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      console.log(
        `${c.bold}${c.cyan}drift report${c.reset}: ${diff.added.length} new finding(s) since baseline`,
      );
      if (diff.added.length === 0) {
        console.log(`${c.green}✓ no regressions${c.reset}`);
      } else {
        for (const f of diff.added.slice(0, 30)) {
          const sevColor = f.severity === "critical" || f.severity === "high" ? c.red : c.yellow;
          console.log(
            `  ${sevColor}•${c.reset} ${f.repo} — ${f.category} (${f.severity}): ${f.detail.slice(0, 80)}`,
          );
        }
        if (diff.added.length > 30)
          console.log(`  ${c.dim}…and ${diff.added.length - 30} more${c.reset}`);
      }
    }
    return diff.added.length === 0;
  }

  const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of report.findings) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;

  if (format === "json") {
    // Emit machine-readable summary; raw findings live in report.reportPath.
    process.stdout.write(
      JSON.stringify(
        {
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          durationSec: durSec,
          root: report.root,
          mode: deep ? "deep" : "default",
          exclude,
          repoCount: report.repoCount,
          findingCount: report.findings.length,
          bySeverity: bySev,
          reportPath: report.reportPath,
          summaryPath: report.summaryPath,
          findings: report.findings,
        },
        null,
        2,
      ) + "\n",
    );
    return bySev.critical === 0 && bySev.high === 0;
  }

  console.log(`${c.bold}Scanned${c.reset} ${report.repoCount} repo(s) in ${durSec}s`);
  console.log(`${c.bold}Findings${c.reset}: ${report.findings.length} total`);
  if (bySev.critical) console.log(`  ${c.red}critical${c.reset}: ${bySev.critical}`);
  if (bySev.high) console.log(`  ${c.red}high    ${c.reset}: ${bySev.high}`);
  if (bySev.medium) console.log(`  ${c.yellow}medium  ${c.reset}: ${bySev.medium}`);
  if (bySev.low) console.log(`  ${c.dim}low     ${c.reset}: ${bySev.low}`);
  if (bySev.info) console.log(`  ${c.dim}info    ${c.reset}: ${bySev.info}`);
  console.log();
  if (report.reportPath) console.log(`${c.dim}  raw:${c.reset}     ${report.reportPath}`);
  if (report.summaryPath) console.log(`${c.dim}  summary:${c.reset} ${report.summaryPath}`);
  console.log();

  return bySev.critical === 0 && bySev.high === 0;
}

/**
 * `kit security prescan-diff <baseline.jsonl> <latest.jsonl>` — drift report.
 *
 * Reads two prescan-JSONL files (the raw report, NOT the summary.md), and
 * surfaces three buckets: added (regressions), removed (fixed), unchanged.
 *
 * Use case: schedule a baseline prescan at first-install, then re-run
 * weekly and diff against the baseline to surface NEW security gaps
 * introduced since.
 */
async function cmdSecurityPrescanDiff(): Promise<boolean> {
  const baseline = process.argv[4];
  const latest = process.argv[5];
  if (!baseline || !latest) {
    console.error(
      `${c.red}Usage: kit security prescan-diff <baseline.jsonl> <latest.jsonl> [--format=text|json]${c.reset}`,
    );
    console.error(
      `${c.dim}Example: kit security prescan-diff ~/.kit/prescans/baseline.jsonl ~/.kit/prescans/latest.jsonl${c.reset}`,
    );
    return false;
  }
  const formatArg = flagValue(process.argv, "--format");
  const format: "text" | "json" = formatArg === "json" ? "json" : "text";
  const { loadReport, diffReports } = await import("../security-prescan.js");

  const a = await loadReport(baseline);
  const b = await loadReport(latest);
  const diff = diffReports(a, b);

  if (format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          baseline,
          latest,
          addedCount: diff.added.length,
          removedCount: diff.removed.length,
          unchangedCount: diff.unchanged.length,
          added: diff.added,
          removed: diff.removed,
        },
        null,
        2,
      ) + "\n",
    );
    return diff.added.length === 0;
  }

  console.log(`${c.bold}${c.cyan}kit security prescan-diff${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  console.log(`  ${c.dim}baseline:${c.reset} ${baseline}`);
  console.log(`  ${c.dim}latest:  ${c.reset} ${latest}\n`);
  console.log(
    `${c.bold}Added (regressions)${c.reset}: ${diff.added.length > 0 ? c.red : c.green}${diff.added.length}${c.reset}`,
  );
  console.log(`${c.bold}Removed (fixed)${c.reset}:     ${c.green}${diff.removed.length}${c.reset}`);
  console.log(
    `${c.bold}Unchanged${c.reset}:           ${c.dim}${diff.unchanged.length}${c.reset}\n`,
  );
  if (diff.added.length) {
    console.log(`${c.red}New findings since baseline:${c.reset}`);
    for (const f of diff.added.slice(0, 20)) {
      console.log(`  ${c.red}•${c.reset} ${f.repo} — ${f.category}: ${f.detail.slice(0, 80)}`);
    }
    if (diff.added.length > 20) {
      console.log(`  ${c.dim}…and ${diff.added.length - 20} more${c.reset}`);
    }
    console.log();
  }
  if (diff.removed.length) {
    console.log(`${c.green}Resolved since baseline:${c.reset}`);
    for (const f of diff.removed.slice(0, 10)) {
      console.log(`  ${c.green}✓${c.reset} ${f.repo} — ${f.category}: ${f.detail.slice(0, 80)}`);
    }
    if (diff.removed.length > 10) {
      console.log(`  ${c.dim}…and ${diff.removed.length - 10} more${c.reset}`);
    }
    console.log();
  }
  // Exit 0 = no regressions; 1 = regressions present (CI-friendly).
  return diff.added.length === 0;
}

export async function cmdSecurity(): Promise<boolean> {
  // Subcommand routing
  const sub = process.argv[3];

  if (sub === "clear-cache") {
    return cmdSecurityClearCache();
  }

  if (sub === "scan-staged") {
    return cmdSecurityScanStaged();
  }

  if (sub === "scan-build") {
    return cmdSecurityScanBuild();
  }

  if (sub === "scan-artifact") {
    return cmdSecurityScanArtifact();
  }

  if (sub === "scan-transcripts") {
    return cmdSecurityScanTranscripts();
  }

  if (sub === "costs") {
    return cmdSecurityCosts();
  }

  if (sub === "check-gitignore") {
    return cmdSecurityCheckGitignore();
  }

  if (sub === "verify-pull") {
    return cmdSecurityVerifyPull();
  }

  if (sub === "prescan") {
    return cmdSecurityPrescan();
  }

  if (sub === "prescan-diff") {
    return cmdSecurityPrescanDiff();
  }

  if (sub !== "policy") {
    console.error(
      `${c.red}Usage: kit security policy [init|add <pkg>|check] | scan-staged | scan-build [dir...] | scan-artifact <path> [--recursive] | scan-transcripts | costs | check-gitignore [--fix] | verify-pull [--base <ref>] | prescan <path> [--deep] | prescan-diff <baseline.jsonl> <latest.jsonl> | clear-cache${c.reset}`,
    );
    return false;
  }
  const action = process.argv[4] ?? "check";

  console.log(`${c.bold}${c.cyan}kit security policy${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (action === "init") {
    const list = await initAllowlist(process.cwd());
    console.log(
      `  ${c.green}✓${c.reset} wrote .kit-allowlist.json  ${c.dim}(${list.packages.length} package(s) recorded)${c.reset}`,
    );
    console.log(
      `\n${c.dim}Defaults: enforce_runtime=true, enforce_dev=false, allow_wildcards=false. Edit ${c.bold}.kit-allowlist.json${c.reset}${c.dim} to tighten or relax.${c.reset}\n`,
    );
    return true;
  }

  if (action === "add") {
    const pkgName = process.argv[5];
    if (!pkgName) {
      console.error(`${c.red}Usage: kit security policy add <pkg>${c.reset}`);
      return false;
    }
    const { added, entry } = await addToAllowlist(pkgName, process.cwd());
    if (!entry) {
      console.error(
        `${c.red}Package "${pkgName}" not found in package.json — install it first.${c.reset}`,
      );
      return false;
    }
    if (added) {
      console.log(
        `  ${c.green}✓${c.reset} added ${c.bold}${entry.name}${c.reset} @ ${entry.range}  ${c.dim}(${entry.reason})${c.reset}`,
      );
    } else {
      console.log(`  ${c.dim}${entry.name}${c.reset} already on the allowlist @ ${entry.range}`);
    }
    return true;
  }

  // check (default)
  const { list, violations } = await checkAllowlist(process.cwd());
  if (!list) {
    console.log(
      `${c.yellow}No .kit-allowlist.json found.${c.reset}  ${c.dim}Run ${c.bold}kit security policy init${c.reset}${c.dim} to bootstrap.${c.reset}\n`,
    );
    return false;
  }

  // Load .kit.toml to evaluate the secrets policy section against the
  // keys the project actually references. Missing config is non-fatal —
  // policy.secrets just doesn't apply.
  let secretViolations: ReturnType<typeof checkSecretPolicy> = [];
  try {
    const dkConfig = await loadConfig(resolveConfigPath());
    const keys = Object.keys(dkConfig.secrets?.keys ?? {});
    if (keys.length > 0) {
      secretViolations = checkSecretPolicy(list, keys);
    }
  } catch {
    /* no .kit.toml — skip secrets policy silently */
  }

  if (violations.length === 0 && secretViolations.length === 0) {
    console.log(`${c.green}✓${c.reset} All dependencies + secrets satisfy policy.\n`);
    return true;
  }

  const fmt = (kind: "runtime" | "dev"): string =>
    kind === "runtime" ? `${c.red}runtime${c.reset}` : `${c.yellow}dev${c.reset}`;

  if (violations.length > 0) {
    console.log(`${c.red}✗ ${violations.length} dependency violation(s):${c.reset}\n`);
    for (const v of violations) {
      const why = v.reason === "not-on-allowlist" ? "not on allowlist" : "wildcard range blocked";
      console.log(
        `  ${c.red}•${c.reset} ${v.name} @ ${v.range}  ${c.dim}[${fmt(v.kind)}]${c.reset}  ${c.dim}${why}${c.reset}`,
      );
    }
    console.log();
  }

  if (secretViolations.length > 0) {
    console.log(`${c.red}✗ ${secretViolations.length} secrets policy violation(s):${c.reset}\n`);
    for (const sv of secretViolations) {
      console.log(
        `  ${c.red}•${c.reset} ${sv.key}  ${c.dim}[${sv.reason}]${c.reset}  ${c.dim}${sv.detail}${c.reset}`,
      );
    }
    console.log(
      `\n${c.dim}Edit ${c.bold}.kit-allowlist.json${c.reset}${c.dim} under ${c.bold}"secrets"${c.reset}${c.dim} to declare scope, TTL, and spend caps per key.${c.reset}`,
    );
  }
  console.log(
    `\n${c.dim}Add a package: ${c.bold}kit security policy add <pkg>${c.reset}${c.dim}, or edit .kit-allowlist.json directly.${c.reset}\n`,
  );
  return false;
}

async function cmdSecurityScanStaged(): Promise<boolean> {
  // Designed to run from a git pre-commit hook. Prints nothing on success so
  // the hook output stays quiet for normal commits; exits non-zero with a
  // structured report when a credential pattern is staged.
  const hits = await scanStagedFiles();
  if (hits.length === 0) return true;

  // Test/fixture hits are REPORTED, never blocking: fake credentials live there by
  // design, and kit's own audit-redaction test has to stage a secret-shaped key to prove
  // the redaction works. Blocking it left `--no-verify` as the only way through, which
  // switches off the entire hook — a gate that cries wolf teaches people to disable it.
  // The repo-wide grep in check-security.ts already drew this line; this gate did not.
  const blocking = hits.filter((h) => !h.advisory);
  const advisory = hits.filter((h) => h.advisory);

  if (advisory.length > 0) {
    console.error(
      `${c.dim}note: ${advisory.length} test/fixture file(s) contain secret-shaped strings (expected — not blocking):${c.reset}`,
    );
    for (const hit of advisory) {
      const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
      console.error(`  ${c.dim}· ${hit.file}  ${labels}${c.reset}`);
    }
    console.error(
      `${c.dim}  trufflehog locally and the CI gitleaks job still scan these and verify live.${c.reset}`,
    );
  }

  if (blocking.length === 0) return true;

  const total = blocking.reduce((sum, h) => sum + h.findings.length, 0);
  console.error(`${c.red}✗ kit secret-scan blocked the commit${c.reset}`);
  console.error(
    `${c.dim}Found ${total} potential secret(s) in ${blocking.length} staged file(s):${c.reset}`,
  );
  for (const hit of blocking) {
    const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
    console.error(`  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
  }
  console.error(
    `\n${c.dim}If a finding is a false positive, you can bypass with ${c.bold}git commit --no-verify${c.reset}${c.dim}, but prefer migrating the value to a vault first (${c.bold}kit secrets migrate${c.reset}${c.dim}).${c.reset}`,
  );
  return false;
}

/**
 * `kit security scan-artifact <path> [--recursive] [--json]` — the ingestion gate for an
 * untrusted file that is about to be trusted (an upload, a downloaded dataset, a vendored
 * blob). Delegates the byte-level scan to a locally-installed ClamAV — kit ships no engine
 * and no signatures — and owns the verdict:
 *   clean      → pass
 *   malicious  → FAIL (exit non-zero), signature names shown
 *   gap        → FAIL: a scan that could not complete (or no scanner at all) is NOT a pass
 * The gap-fails-closed rule is the point: this is an ingestion gate, so "we could not check"
 * must never read as "it is fine".
 */
async function cmdSecurityScanArtifact(): Promise<boolean> {
  const args = process.argv.slice(4);
  const json = args.includes("--json");
  const recursive = args.includes("--recursive") || args.includes("-r");
  const target = args.find((a) => !a.startsWith("-"));
  if (!target) {
    console.error(
      `${c.red}Usage: kit security scan-artifact <path> [--recursive] [--json]${c.reset}`,
    );
    return false;
  }
  if (!existsSync(target)) {
    console.error(
      `${c.red}✗ scan-artifact: ${target} does not exist — nothing scanned (gap).${c.reset}`,
    );
    return false;
  }

  const { scanFileForMalware } = await import("../malware-scan.js");
  const r = await scanFileForMalware(target, undefined, { recursive });

  if (json) {
    console.log(JSON.stringify({ target, recursive, ...r }, null, 2));
    return r.verdict === "clean";
  }

  const engine = r.engine ? ` ${c.dim}(via ${r.engine})${c.reset}` : "";
  if (r.verdict === "clean") {
    console.log(
      `${c.green}✓ scan-artifact: ${target} — no matches for ${SECRET_SHAPE_COUNT} known credential shapes${c.reset}${engine}`,
    );
    console.log(`  ${c.dim}${r.detail}${c.reset}`);
    return true;
  }
  if (r.verdict === "malicious") {
    console.error(`${c.red}✗ scan-artifact: ${target} — MALWARE${c.reset}${engine}`);
    console.error(`  ${c.red}${r.signatures.join(", ")}${c.reset}`);
    console.error(`  ${c.dim}${r.detail}${c.reset}`);
    return false;
  }
  // scanerror / not-installed → gap, and a gap fails an ingestion gate.
  console.error(`${c.yellow}? scan-artifact: ${target} — GAP (not a pass)${c.reset}${engine}`);
  console.error(`  ${c.dim}${r.detail}${c.reset}`);
  return false;
}

async function cmdSecurityScanBuild(): Promise<boolean> {
  // Optional positional: extra dirs to scan beyond the defaults.
  const extras = process.argv.slice(4).filter((a) => !a.startsWith("--"));
  const hits = await scanBuildArtifacts(process.cwd(), extras.length > 0 ? extras : undefined);
  if (hits.length === 0) {
    // The denominator belongs in the claim: "no patterns found" reads as "no secrets there", and
    // the honest statement is "none of the shapes kit knows".
    console.log(
      `${c.green}✓ scan-build: no matches for ${SECRET_SHAPE_COUNT} known credential shapes${c.reset}${c.dim} — a shape outside that set is not detected${c.reset}`,
    );
    return true;
  }
  const total = hits.reduce((sum, h) => sum + h.findings.length, 0);
  console.error(
    `${c.red}✗ scan-build: ${total} potential secret(s) in ${hits.length} build file(s):${c.reset}`,
  );
  for (const hit of hits.slice(0, 20)) {
    const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
    console.error(`  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
  }
  if (hits.length > 20) {
    console.error(`  ${c.dim}… and ${hits.length - 20} more${c.reset}`);
  }
  console.error(
    `\n${c.dim}Typical cause: a server-only env var (e.g. STRIPE_SECRET_KEY) is referenced via NEXT_PUBLIC_* and got inlined into the client bundle. Rebuild after fixing.${c.reset}`,
  );
  return false;
}

async function cmdSecurityScanTranscripts(): Promise<boolean> {
  const hits = await scanTranscripts(process.cwd());
  if (hits.length === 0) {
    console.log(
      `${c.green}✓ scan-transcripts: no credentials found in agent state or prompt cache.${c.reset}`,
    );
    return true;
  }
  const total = hits.reduce((sum, h) => sum + h.findings.length, 0);
  console.error(
    `${c.red}✗ scan-transcripts: ${total} potential secret(s) in ${hits.length} transcript/cache file(s):${c.reset}`,
  );
  for (const hit of hits.slice(0, 20)) {
    const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
    console.error(`  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
  }
  if (hits.length > 20) {
    console.error(`  ${c.dim}… and ${hits.length - 20} more${c.reset}`);
  }
  console.error(
    `\n${c.yellow}Rotate the leaked credential and purge the offending file(s) — they get replayed into every future agent prompt until cleared.${c.reset}\n`,
  );
  return false;
}

async function cmdSecurityCosts(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit security costs${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // Pull spend-caps from the allowlist (if present) so cost samples can be
  // compared against the declared policy.
  const { readAllowlist } = await import("../security-policy.js");
  const list = await readAllowlist(process.cwd());
  const caps: Record<string, number | undefined> = {};
  if (list?.secrets) {
    for (const [keyName, entry] of Object.entries(list.secrets)) {
      caps[keyName] = entry.spend_cap_usd ?? list.policy.default_spend_cap_usd;
    }
  }

  const samples = await sampleCosts({ caps });
  if (samples.length === 0) {
    console.log(
      `${c.dim}No supported provider keys found in env. Set STRIPE_SECRET_KEY (or other supported providers) to enable cost samples.${c.reset}\n`,
    );
    return true;
  }

  let allOk = true;
  for (const s of samples) {
    const icon =
      s.status === "ok"
        ? `${c.green}✓${c.reset}`
        : s.status === "warn"
          ? `${c.yellow}!${c.reset}`
          : s.status === "over-cap" || s.status === "auth-failed"
            ? `${c.red}✗${c.reset}`
            : `${c.dim}-${c.reset}`;
    const capLabel =
      s.capUsd !== undefined ? `cap=${s.capUsd.toFixed(2)} USD` : `${c.yellow}no cap${c.reset}`;
    console.log(
      `  ${icon} ${s.provider.padEnd(10)}  current=${s.current.toFixed(2)} ${s.unit}  ${capLabel}  ${c.dim}${s.detail}${c.reset}`,
    );
    if (s.status === "over-cap" || s.status === "auth-failed") allOk = false;
  }

  console.log();
  if (!allOk) {
    console.log(
      `${c.red}One or more keys are over cap or failed auth. Rotate / reduce / refresh.${c.reset}\n`,
    );
  }
  return allOk;
}

async function cmdSecurityVerifyPull(): Promise<boolean> {
  // kit security verify-pull [--base <ref>] [--head <ref>] [--json]
  const args = process.argv.slice(4);
  const base = flagValue(args, "--base") ?? "HEAD~1";
  const head = flagValue(args, "--head") ?? "HEAD";
  const jsonMode = hasFlag(args, "--json");

  const report = await auditPull(process.cwd(), base, head);
  const severity = reportSeverity(report);

  if (jsonMode) {
    console.log(JSON.stringify({ severity, ...report }, null, 2));
    return severity !== "fail";
  }

  console.log(
    `${c.bold}${c.cyan}kit security verify-pull${c.reset}  ${c.dim}(${base} → ${head})${c.reset}`,
  );
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (report.changedFiles.length === 0) {
    console.log(`${c.dim}No files changed in this range. Nothing to audit.${c.reset}\n`);
    return true;
  }

  console.log(`${c.dim}${report.changedFiles.length} file(s) changed${c.reset}\n`);

  if (report.newDependencies.length > 0) {
    console.log(`${c.yellow}⚠ ${report.newDependencies.length} new dependency/-ies:${c.reset}`);
    for (const dep of report.newDependencies) {
      console.log(
        `  ${c.yellow}•${c.reset} ${dep}  ${c.dim}→ run ${c.bold}kit triage npm ${dep}${c.reset}${c.dim} before installing${c.reset}`,
      );
    }
    console.log();
  }

  if (report.removedGitignoreEntries.length > 0) {
    const sensitive = report.removedGitignoreEntries.filter((l) =>
      /\.env|\.pem|\.key|id_rsa/.test(l),
    );
    const severityIcon = sensitive.length > 0 ? `${c.red}✗` : `${c.yellow}⚠`;
    console.log(
      `${severityIcon}${c.reset} ${report.removedGitignoreEntries.length} .gitignore entry/-ies removed:`,
    );
    for (const line of report.removedGitignoreEntries) {
      const hot = /\.env|\.pem|\.key|id_rsa/.test(line);
      const tag = hot ? `${c.red}[sensitive]${c.reset}` : `${c.dim}[low]${c.reset}`;
      console.log(`  ${hot ? c.red : c.yellow}•${c.reset} ${line}  ${tag}`);
    }
    console.log();
  }

  if (report.plaintextHits.length > 0) {
    const total = report.plaintextHits.reduce((sum, h) => sum + h.findings.length, 0);
    console.log(
      `${c.red}✗ ${total} plaintext secret(s) introduced in ${report.plaintextHits.length} file(s):${c.reset}`,
    );
    for (const hit of report.plaintextHits.slice(0, 20)) {
      const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
      console.log(`  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
    }
    if (report.plaintextHits.length > 20) {
      console.log(`  ${c.dim}… ${report.plaintextHits.length - 20} more${c.reset}`);
    }
    console.log();
  }

  if (report.allowlistChanged || report.policyChanged || report.kitTomlChanged) {
    console.log(`${c.yellow}⚠ Security-policy files modified:${c.reset}`);
    if (report.allowlistChanged) console.log(`  ${c.yellow}•${c.reset} .kit-allowlist.json`);
    if (report.policyChanged) console.log(`  ${c.yellow}•${c.reset} .kit-policy.json`);
    if (report.kitTomlChanged) console.log(`  ${c.yellow}•${c.reset} .kit.toml`);
    console.log(
      `${c.dim}  → run ${c.bold}kit security policy check${c.reset}${c.dim} to verify the new state.${c.reset}\n`,
    );
  }

  if (severity === "ok") {
    console.log(`${c.green}✓ No security concerns in this pull.${c.reset}\n`);
    return true;
  }
  if (severity === "warn") {
    console.log(
      `${c.yellow}⚠ Pull contains items worth a second look — address before running install/deploy.${c.reset}\n`,
    );
    return true;
  }
  console.log(
    `${c.red}✗ Pull contains security regressions — review before continuing.${c.reset}\n`,
  );
  return false;
}

async function cmdSecurityCheckGitignore(): Promise<boolean> {
  const args = process.argv.slice(4);
  const fix = hasFlag(args, "--fix");

  console.log(`${c.bold}${c.cyan}kit security check-gitignore${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const result = await checkGitignore(process.cwd());
  const committed = await findCommittedSensitive(process.cwd());

  if (!result.exists) {
    console.log(`${c.yellow}⚠ No .gitignore file in this repo.${c.reset}\n`);
  } else {
    console.log(
      `${c.dim}.gitignore: ${result.presentPatterns.length}/${result.presentPatterns.length + result.missingPatterns.length} required patterns present${c.reset}\n`,
    );
  }

  if (result.missingPatterns.length === 0) {
    console.log(`${c.green}✓ All required ignore patterns present.${c.reset}`);
  } else {
    console.log(
      `${c.red}✗ Missing ${result.missingPatterns.length} required pattern(s):${c.reset}\n`,
    );
    for (const m of result.missingPatterns) {
      console.log(
        `  ${c.red}•${c.reset} ${c.bold}${m.pattern.padEnd(28)}${c.reset}  ${c.dim}${m.reason}${c.reset}`,
      );
    }
    console.log();
  }

  if (committed.length > 0) {
    console.log(
      `${c.red}⚠ ${committed.length} sensitive file(s) already tracked in git:${c.reset}\n`,
    );
    for (const path of committed.slice(0, 20)) {
      console.log(`  ${c.red}•${c.reset} ${path}`);
    }
    if (committed.length > 20) {
      console.log(`  ${c.dim}… ${committed.length - 20} more${c.reset}`);
    }
    console.log(
      `\n${c.yellow}Adding these to .gitignore does NOT untrack them. Use ${c.bold}git rm --cached <path>${c.reset}${c.yellow} + commit, then rotate any credentials they contained.${c.reset}\n`,
    );
  }

  if (fix && result.missingPatterns.length > 0) {
    const patch = await patchGitignore(process.cwd());
    console.log(`${c.green}✓${c.reset} appended ${patch.added} pattern(s) to .gitignore`);
    console.log(
      `${c.dim}Review the new block, then ${c.bold}git add .gitignore && git commit${c.reset}${c.dim}.${c.reset}\n`,
    );
    return true;
  }

  if (result.missingPatterns.length > 0 && !fix) {
    console.log(
      `${c.dim}Run with ${c.bold}--fix${c.reset}${c.dim} to append the missing patterns to .gitignore.${c.reset}\n`,
    );
  }

  return result.missingPatterns.length === 0 && committed.length === 0;
}

async function cmdSecurityClearCache(): Promise<boolean> {
  // Sub-sub: `kit security clear-cache [bumblebee]`. Defaults to bumblebee
  // since that's the only cached binary kit currently manages whose
  // checksum can mismatch in normal dev use.
  const target = process.argv[4] ?? "bumblebee";

  console.log(`${c.bold}${c.cyan}kit security clear-cache${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  console.log(`${c.yellow}⚠ This will delete the cached ${target} binary.${c.reset}`);
  console.log(
    `${c.dim}Use when you have intentionally rebuilt the scanner locally (e.g. a feature branch) and the pinned checksum no longer matches.${c.reset}`,
  );
  console.log(
    `${c.dim}If you did NOT rebuild and the checksum still mismatches, investigate for tampering — do not clear blindly.${c.reset}\n`,
  );

  const nonInteractive = isNonInteractive();
  if (!nonInteractive) {
    const ok = await promptConfirm(`Continue? [Y/n] (auto-yes in 8s): `, 8000);
    if (!ok) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return false;
    }
  }

  if (target !== "bumblebee") {
    console.error(
      `${c.red}Unknown cache target: ${target} (only 'bumblebee' is supported)${c.reset}`,
    );
    return false;
  }

  const result = await clearBumblebeeCache();
  if (result.removed) {
    console.log(`  ${c.green}✓${c.reset} removed ${result.path}`);
    console.log(
      `${c.dim}Next ${c.bold}kit check${c.reset}${c.dim} will re-download and re-verify the scanner.${c.reset}\n`,
    );
  } else {
    console.log(`  ${c.dim}nothing to remove at ${result.path}${c.reset}\n`);
  }
  return true;
}
