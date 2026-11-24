// `kit scan` command — extracted from cli.ts (incremental split).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type kitConfig } from "../config.js";
import { c } from "../utils/colors.js";
import { hasFlag, envTruthy } from "../utils/flags.js";
import { resolveConfigPath } from "../cli-shared.js";
import { hasMarker, scanProvidersTracked } from "../scan-detect.js";
import { DEFAULT_SCAN_TIMEOUT_MS, isFailedRun } from "../scan-abort.js";
import { sanitizeDisplayText } from "../display-text.js";
import type { VerifyResult } from "../airgap/threat-data.js";
import {
  applyScopeGate,
  plannedScopeGaps,
  planScans,
  requiredScanIds,
  scanScopeMessage,
  type ScanScopeGap,
} from "../scan-plan.js";
import type { IntelStatus } from "../exploit-intel.js";
import {
  scanHealthGate,
  type AirGapPlan,
  type MergedFinding,
  type ScanGate,
  type ScanGateOptions,
  type ScannerDef,
  type ScannerRun,
} from "../scanners.js";

/** Whether CISA KEV and FIRST EPSS answered this run, and why not. */
interface IntelSummary {
  enabled: boolean;
  kevChecked: boolean;
  epssChecked: boolean;
  kevStatus?: IntelStatus;
  epssStatus?: IntelStatus;
  notes: string[];
}

/** What the findings and the scanner-health gate add up to, before it is printed. */
interface ScanVerdict {
  intel: IntelSummary;
  runs: ScannerRun[];
  findings: MergedFinding[];
  suppressed: number;
  bad: number;
  gate: ScanGate;
  scopeGaps: ScanScopeGap[];
  strict: boolean;
  ok: boolean;
}

export async function cmdScan(): Promise<boolean> {
  const cwd = process.cwd();
  // Config-free by design: scanning is project-agnostic, so a missing .kit.toml is
  // NOT an error — fall back to an empty config (air-gap + tooling tokens then come
  // from env). This is what lets `kit scan` run in any repo without `kit init` first.
  const configPath = resolveConfigPath();
  const config = existsSync(configPath) ? await loadConfig(configPath) : ({} as kitConfig);

  // Delegate library: [scan].delegates toggles which external scanners kit shells
  // out to. kit delegates DETECTION, never its verdict. --list-delegates enumerates
  // the registry with on/off state and exits.
  if (hasFlag(process.argv, "--list-delegates")) {
    await printDelegates(config.scan?.delegates);
    return true;
  }

  const plan = planScans(cwd, config);
  const { airgap, threatDataGap } = await applyAirGap(plan.scanners, config);
  const scopeGaps = plannedScopeGaps(plan, airgap.scanners);
  for (const gap of scopeGaps) console.error(`${c.yellow}! ${scanScopeMessage(gap)}${c.reset}`);
  if (threatDataGap) scopeGaps.unshift(threatDataGap);
  const policy = scanPolicy(config, plan.scanners);
  const { merged, runs } = threatDataGap
    ? { merged: [], runs: [] }
    : await executeScanners(cwd, airgap, await fetchToolingTokens(config, plan.scanners));

  if (hasFlag(process.argv, "--update-baseline")) {
    const gate = assessScanHealth(runs, scopeGaps, { ...policy, strict: true });
    printGate(gate);
    if (!gate.ok || !hasCompletedScan(runs)) {
      console.error("Scan coverage cannot support a baseline update.");
      return false;
    }
    await updateScanBaseline(cwd, merged);
    return true;
  }
  const verdict = await judgeScan(cwd, config, { merged, runs, scopeGaps }, policy);
  await printVerdict(verdict);
  return verdict.ok;
}

async function printDelegates(delegates: readonly string[] | undefined): Promise<void> {
  const { SCANNERS, isScannerEnabled } = await import("../scanners.js");
  for (const s of SCANNERS) {
    const on = isScannerEnabled(s.id, delegates);
    const tag = on ? `${c.green}on ${c.reset}` : `${c.dim}off${c.reset}`;
    const notes = [s.needsToken ? `needs ${s.needsToken}` : null, s.cloudOnly ? "cloud-only" : null]
      .filter(Boolean)
      .join(", ");
    console.log(`${tag} ${s.id.padEnd(13)} ${s.format}${notes ? `  (${notes})` : ""}`);
  }
}

/**
 * Air-gap posture from `.kit.toml [air_gap]` + env (env overrides). When enabled, drop cloud-only
 * scanners and run the rest against local DBs with no network. See docs/AIR_GAP.md.
 * A threat-data gap prevents scanner and baseline execution.
 */
async function applyAirGap(
  selected: ScannerDef[],
  config: kitConfig,
): Promise<{ airgap: AirGapPlan; threatDataGap?: ScanScopeGap }> {
  const { airGapScanners } = await import("../scanners.js");
  const { resolveAirGap } = await import("../airgap/config.js");
  const ag = resolveAirGap(config.air_gap, process.env);
  const airgap = airGapScanners(selected, ag.enabled);
  if (!ag.enabled) return { airgap };
  const info =
    hasFlag(process.argv, "--json") || hasFlag(process.argv, "--sarif")
      ? console.error
      : console.log;
  info(
    `${c.dim}air-gap mode: offline scanners only${airgap.dropped.length ? ` (skipping cloud-only: ${airgap.dropped.join(", ")})` : ""}${c.reset}`,
  );
  await warnRegistrySemgrep();
  const maxAgeDays = config.air_gap?.threat_data_max_age_days;
  if (!ag.threatDataDir && maxAgeDays === undefined) return { airgap };
  const result = await verifyScanThreatData(ag.threatDataDir, ag.threatDataPubkey, maxAgeDays);
  if (!result.ok) {
    const reason = sanitizeDisplayText(result.reason);
    console.error(`${c.red}✗ ${reason} (fail-closed)${c.reset}`);
    return {
      airgap,
      threatDataGap: {
        kind: "threat-data",
        target: sanitizeDisplayText(ag.threatDataDir ?? "offline bundle"),
        reason,
        evidenceStatus: result.status,
      },
    };
  }
  info(
    `${c.dim}verified threat-data bundle: ${result.artifacts} artifact(s) signed + checksummed${c.reset}`,
  );
  Object.assign(airgap.env, result.env);
  return { airgap };
}

/**
 * Loud rejection: a registry KIT_SEMGREP_CONFIG (p/<pack>, r/<rule>, auto) would fetch rules from
 * semgrep.dev = egress, so semgrep is NOT run air-gapped. Only a LOCAL ruleset path enables
 * semgrep offline.
 */
async function warnRegistrySemgrep(): Promise<void> {
  const { isLocalSemgrepConfig } = await import("../scanners.js");
  const semCfg = process.env.KIT_SEMGREP_CONFIG?.trim();
  if (semCfg && !isLocalSemgrepConfig(semCfg)) {
    console.error(
      `${c.yellow}! air-gap: KIT_SEMGREP_CONFIG='${semCfg}' is a registry config (would fetch from the semgrep registry = egress) — semgrep is NOT run air-gapped. Point KIT_SEMGREP_CONFIG at a local ruleset path to enable it offline.${c.reset}`,
    );
  }
}

/**
 * Verified offline threat-data bundle (optional): point scanners at a signed, integrity-checked
 * local DB set. Return the evidence status when verification fails.
 */
async function verifyScanThreatData(
  tdDir: string | undefined,
  pubRef: string | undefined,
  maxAgeDays: number | undefined,
): Promise<VerifyResult> {
  if (!tdDir) {
    return {
      ok: false,
      status: "missing",
      reason: "threat-data freshness policy requires a bundle",
    };
  }
  if (!pubRef) {
    return {
      ok: false,
      status: "missing",
      reason:
        "air-gap threat-data dir set but no public key (threat_data_pubkey / KIT_THREAT_DATA_PUBKEY)",
    };
  }
  const { verifyThreatData } = await import("../airgap/threat-data.js");
  let publicKeyPem: string;
  try {
    publicKeyPem = pubRef.startsWith("-----BEGIN ") ? pubRef : readFileSync(pubRef, "utf8");
  } catch {
    return {
      ok: false,
      status: "missing",
      reason: "threat-data bundle rejected: public key cannot be read",
    };
  }
  const res = verifyThreatData({
    dir: tdDir,
    publicKeyPem,
    maxAgeDays,
    readFile: (rel) => readFileSync(resolve(tdDir, rel)),
    resolvePath: (rel) => resolve(tdDir, rel),
  });
  return res.ok ? res : { ...res, reason: `threat-data bundle rejected: ${res.reason}` };
}

/**
 * Resolve scanner tokens (SNYK_TOKEN, …) from a configured tooling Infisical project so `kit scan`
 * works without an `infisical run` wrapper (#65). The value flows vault→subprocess env; it is
 * never logged.
 */
async function fetchToolingTokens(
  config: kitConfig,
  selected: ScannerDef[],
): Promise<Record<string, string>> {
  const toolingTokens: Record<string, string> = {};
  const tooling = config.scan?.tooling;
  if (!tooling?.project_id) return toolingTokens;
  const { fetchInfisicalProjectSecrets } = await import("../secret-backends.js");
  const map = await fetchInfisicalProjectSecrets({
    project_id: tooling.project_id,
    environment: tooling.env,
  });
  for (const s of selected) {
    if (s.needsToken && !process.env[s.needsToken] && map.has(s.needsToken)) {
      toolingTokens[s.needsToken] = map.get(s.needsToken)!;
    }
  }
  return toolingTokens;
}

async function executeScanners(
  cwd: string,
  airgap: AirGapPlan,
  toolingTokens: Record<string, string>,
): Promise<{ merged: MergedFinding[]; runs: ScannerRun[] }> {
  const { runScanners, scannerEnv, dropProviderExclusion } = await import("../scanners.js");
  const { resolveToolBin } = await import("../utils/resolveTool.js");
  const { execFileNoThrow } = await import("../utils/execFileNoThrow.js");
  const { runGrypeDirectory } = await import("../scan-grype-coverage.js");
  const { runSemgrepWithCoverage } = await import("../scan-semgrep-coverage.js");
  const { runSnykWithCoverage } = await import("../scan-snyk-coverage.js");
  const { findIacFiles } = await import("../check-iac-detect.js");
  const { runTrivyWithCoverage } = await import("../scan-trivy-coverage.js");

  // A tracked file under .terraform/providers is not downloaded output: scan it like any other.
  const scanProviders = await scanProvidersTracked(cwd);
  if (scanProviders) {
    console.error(
      `${c.yellow}! git tracks files under .terraform/providers (or could not be asked), so that directory is scanned this run.${c.reset}`,
    );
  }
  const planned = scanProviders ? airgap.scanners.map(dropProviderExclusion) : airgap.scanners;

  return runScanners(
    {
      resolve: (bin) => resolveToolBin(bin),
      run: async (bin, args, timeoutMs, projectDir, evidence) => {
        const scannerCwd = projectDir ? resolve(cwd, projectDir) : cwd;
        const run = (argv: string[], directory: string, limitMs?: number) =>
          execFileNoThrow(bin, argv, {
            timeout: limitMs ?? timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
            cwd: directory,
            // A scanner's report grows with what it finds (Semgrep SARIF was 2 MiB on one repo).
            maxBuffer: 64 * 1024 * 1024,
            env: scannerEnv(process.env, { ...airgap.env, ...toolingTokens }, directory),
          });
        if (evidence === "grype-directory") return runGrypeDirectory(scannerCwd, args, run);
        if (evidence === "semgrep") return runSemgrepWithCoverage(scannerCwd, args, run);
        if (evidence === "snyk") return runSnykWithCoverage(scannerCwd, args, run);
        if (evidence) return runTrivyWithCoverage(scannerCwd, args, evidence, run);
        return run(args, scannerCwd);
      },
      hasEnv: (name) => Boolean(process.env[name] || toolingTokens[name]),
      detect: async (markers, projectDir, evidence) => {
        if (evidence === "trivy-config")
          return (await findIacFiles(projectDir ? resolve(cwd, projectDir) : cwd)).length > 0;
        return hasMarker(cwd, markers);
      },
    },
    planned,
  );
}

/**
 * --update-baseline: freeze the current findings as accepted (#59 noise-reduction), reusing the
 * shared .kit-baseline.json under a "scan" category.
 */
async function updateScanBaseline(cwd: string, merged: MergedFinding[]): Promise<void> {
  const { dedupKey } = await import("../scanners.js");
  const { loadBaseline, baselineSet, saveBaseline } = await import("../baseline.js");
  const bl = await loadBaseline(cwd);
  baselineSet(bl, "scan", "findings", merged.map(dedupKey));
  await saveBaseline(bl, cwd);
  console.log(
    `${c.green}baseline updated${c.reset}  ${c.dim}${merged.length} scan finding(s) accepted into .kit-baseline.json${c.reset}`,
  );
}

function scanPolicy(config: kitConfig, planned: readonly ScannerDef[]) {
  return {
    strict: hasFlag(process.argv, "--strict") || envTruthy(process.env.KIT_CI_STRICT),
    requiredScanners: requiredScanIds(config.governance?.scan?.required_scanners ?? [], planned),
  };
}

function assessScanHealth(
  runs: ScannerRun[],
  scopeGaps: ScanScopeGap[],
  policy: ScanGateOptions,
): ScanGate {
  const gate = scanHealthGate(runs, policy);
  applyScopeGate(gate, scopeGaps, policy);
  return gate;
}

async function judgeScan(
  cwd: string,
  config: kitConfig,
  evidence: { merged: MergedFinding[]; runs: ScannerRun[]; scopeGaps: ScanScopeGap[] },
  policy: ReturnType<typeof scanPolicy>,
): Promise<ScanVerdict> {
  const { suppressBaselined } = await import("../scanners.js");
  const { loadBaseline, baselineGet } = await import("../baseline.js");
  const accepted = new Set(baselineGet(await loadBaseline(cwd), "scan", "findings"));
  const { merged, runs, scopeGaps } = evidence;
  const { kept, suppressed } = suppressBaselined(merged, accepted);
  const { findings, intel } = await withExploitIntel(kept, config);
  // A CVE in CISA KEV is exploited in the wild: it fails the scan whatever its severity label says.
  const bad = findings.filter(
    (m) => m.kev || m.severity === "critical" || m.severity === "high",
  ).length;

  // Scanner-HEALTH gate (separate from findings): a scanner that did not actually
  // run (crashed/absent/no-token) must be able to force a non-zero exit so a green
  // verdict never hides a broken scanner. Backward-compatible — a non-running
  // scanner stays a loud WARN unless strict or a required scanner missed.
  const { strict } = policy;
  const gate = assessScanHealth(runs, scopeGaps, policy);
  if (strict && gate.ok && !hasCompletedScan(runs))
    gate.failures.push("No scanner completed. Scan coverage is unverified [strict].");
  // A feed that did not answer is a scanner that did not run: a warning, and a failure in strict.
  for (const note of intel.notes) {
    if (strict && !(intel.kevChecked && intel.epssChecked)) gate.failures.push(note);
    else gate.warnings.push(note);
  }
  if (gate.failures.length > 0) gate.ok = false;
  return {
    intel,
    runs,
    findings,
    suppressed,
    bad,
    gate,
    scopeGaps,
    strict,
    ok: bad === 0 && gate.ok,
  };
}

/**
 * Mark findings with CISA KEV and FIRST EPSS and order them KEV first. Off with
 * `[scan] exploit_intel = false` or KIT_EXPLOIT_INTEL=0; air gap reads only the cache.
 */
async function withExploitIntel(
  findings: MergedFinding[],
  config: kitConfig,
): Promise<{ findings: MergedFinding[]; intel: IntelSummary }> {
  const off = config.scan?.exploit_intel === false || process.env.KIT_EXPLOIT_INTEL === "0";
  if (off) {
    return {
      findings,
      intel: { enabled: false, kevChecked: false, epssChecked: false, notes: [] },
    };
  }
  const { applyIntel, cveIdsOf, defaultIntelDeps, loadExploitIntel } =
    await import("../exploit-intel.js");
  const { resolveAirGap } = await import("../airgap/config.js");
  const offline = resolveAirGap(config.air_gap, process.env).enabled;
  const intel = await loadExploitIntel(findings.flatMap(cveIdsOf), defaultIntelDeps(offline));
  return {
    findings: applyIntel(findings, intel),
    intel: {
      enabled: true,
      kevChecked: intel.kevChecked,
      epssChecked: intel.epssChecked,
      kevStatus: intel.kevStatus,
      epssStatus: intel.epssStatus,
      notes: intel.notes,
    },
  };
}

async function printVerdict(v: ScanVerdict): Promise<void> {
  const completed = hasCompletedScan(v.runs);
  const coverage =
    completed && v.gate.failures.length === 0 && v.gate.warnings.length === 0
      ? undefined
      : "partial";
  if (hasFlag(process.argv, "--sarif")) {
    const { toSarif } = await import("../sbom.js");
    const scanners = v.runs.map(({ id, status, findings, reportGap }) => ({
      id,
      status,
      findings,
      reportGap,
    }));
    console.log(
      JSON.stringify(toSarif(v.findings, coverage === undefined, scanners, v.scopeGaps), null, 2),
    );
    return;
  }
  if (hasFlag(process.argv, "--json")) {
    const { runs, findings, suppressed, ok, gate, strict, intel } = v;
    console.log(
      JSON.stringify(
        {
          runs,
          findings,
          suppressed,
          ok,
          scannerGate: gate,
          strict,
          exploitIntel: intel,
          coverage,
          ...(v.scopeGaps.length ? { scopeGaps: v.scopeGaps } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  const suppressNote = v.suppressed > 0 ? `  ${c.dim}(${v.suppressed} baselined)${c.reset}` : "";
  console.log(
    `${c.bold}kit scan${c.reset}  ${c.dim}external scanners → one merged verdict${c.reset}${suppressNote}`,
  );
  printRuns(v.runs);
  console.log("");
  printFindings(v.findings, v.suppressed, completed, v.scopeGaps.length > 0);
  const kev = v.findings.filter((f) => f.kev).length;
  if (v.bad > 0) {
    console.log(
      `${c.red}${v.bad} high/critical${kev > 0 ? ` (${kev} in CISA KEV: exploited in the wild)` : ""}${c.reset}`,
    );
  }
  printGate(v.gate);
}

function printRuns(runs: ScannerRun[]): void {
  for (const r of runs) {
    const mark =
      r.status === "ran"
        ? `${c.green}✓${c.reset}`
        : isFailedRun(r.status)
          ? `${c.red}✗${c.reset}`
          : `${c.dim}−${c.reset}`;
    const note =
      r.status === "ran"
        ? `${r.findings} finding(s)`
        : r.reason
          ? `${r.status}: ${r.reason}`
          : r.status;
    console.log(`  ${mark} ${r.id}  ${c.dim}${note}${c.reset}`);
  }
}

function hasCompletedScan(runs: ScannerRun[]): boolean {
  return runs.some((run) => run.status === "ran");
}

function printFindings(
  findings: MergedFinding[],
  suppressed: number,
  completed: boolean,
  scopeIncomplete: boolean,
): void {
  if (findings.length === 0) {
    if (!completed) {
      console.log("  No scanner completed. Scan coverage is unverified.");
      return;
    }
    if (scopeIncomplete) {
      console.log(
        `  ${c.yellow}Scan coverage is incomplete. No findings from the completed scans.${c.reset}`,
      );
      return;
    }
    console.log(
      `  ${c.green}no findings${suppressed > 0 ? " (after baseline)" : " from the scanners that ran"}${c.reset}`,
    );
    return;
  }
  for (const m of findings) {
    const sev = m.severity ?? "low";
    const color =
      sev === "critical" || sev === "high" ? c.red : sev === "medium" ? c.yellow : c.dim;
    const kev = m.kev
      ? ` ${c.red}${c.bold}KEV${m.kev.ransomware ? "+ransomware" : ""}${c.reset}`
      : "";
    const epss = m.epss ? `  ${c.dim}EPSS ${m.epss.score.toFixed(2)}${c.reset}` : "";
    console.log(
      `  ${color}${sev.toUpperCase().padEnd(8)}${c.reset}${kev} ${m.name}${epss}  ${c.dim}[${m.scanners.join("+")}]${c.reset}`,
    );
  }
}

/** Honest scanner-health reporting: name WHICH scanner did not run and why. */
function printGate(gate: ScanGate): void {
  for (const w of gate.warnings) {
    console.log(`  ${c.yellow}! ${w}${c.reset}`);
  }
  for (const fmsg of gate.failures) {
    console.log(`  ${c.red}✗ ${fmsg}${c.reset}`);
  }
  if (gate.warnings.length > 0 && gate.ok) {
    console.log(
      `${c.dim}  (a non-running scanner is a warn; use --strict or [governance.scan] required_scanners to hard-fail)${c.reset}`,
    );
  }
}
