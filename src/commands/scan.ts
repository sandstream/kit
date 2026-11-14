// `kit scan` command — extracted from cli.ts (incremental split).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type kitConfig } from "../config.js";
import { c } from "../utils/colors.js";
import { hasFlag, envTruthy } from "../utils/flags.js";
import { resolveConfigPath } from "../cli-shared.js";
import { hasMarker, scanProvidersTracked } from "../scan-detect.js";
import { mavenSbomScanners } from "../maven-sbom.js";
import { DEFAULT_SCAN_TIMEOUT_MS, isFailedRun } from "../scan-abort.js";
import { resolveProjectPaths } from "../projects-config.js";
import { expandPerProject } from "../scan-projects.js";
import type { AirGapPlan, MergedFinding, ScanGate, ScannerDef, ScannerRun } from "../scanners.js";

/** What the findings and the scanner-health gate add up to, before it is printed. */
interface ScanVerdict {
  runs: ScannerRun[];
  findings: MergedFinding[];
  suppressed: number;
  bad: number;
  gate: ScanGate;
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

  const selected = await selectScanners(cwd, config);
  const airgap = await applyAirGap(selected, config);
  if (!airgap) return false;
  const toolingTokens = await fetchToolingTokens(config, selected);
  const { merged, runs } = await executeScanners(cwd, airgap, toolingTokens);

  if (hasFlag(process.argv, "--update-baseline")) {
    await updateScanBaseline(cwd, merged);
    return true;
  }
  const verdict = await judgeScan(cwd, config, merged, runs);
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

/** The enabled scanners, per declared project, plus the Maven SBOM and container-image scanners. */
async function selectScanners(cwd: string, config: kitConfig): Promise<ScannerDef[]> {
  const { SCANNERS, enabledScanners } = await import("../scanners.js");
  const delegates = config.scan?.delegates;
  // `[projects] paths`: a scanner that does not recurse runs once per project directory.
  const declared = resolveProjectPaths(cwd, config.projects?.paths);
  for (const r of declared.refused) {
    console.error(`${c.yellow}! [projects] path not scanned: ${r.path} (${r.reason})${c.reset}`);
  }
  const selected = expandPerProject(enabledScanners(SCANNERS, delegates), declared.projects);
  selected.push(...mavenSbomScanners(cwd, delegates));

  // Container images (L1): `[scan].images` and, when asked, the Dockerfiles' FROM lines. Each image
  // adds an osv-scanner and a trivy run that pull the image, so air-gap mode drops them below.
  const { collectImages, configuredImages, imageScanners } = await import("../image-scan.js");
  const imagePlan = collectImages(cwd, {
    configured: configuredImages(config.scan?.images),
    fromDockerfiles: config.scan?.images_from_dockerfiles === true,
  });
  for (const s of imagePlan.skipped) {
    console.error(`${c.yellow}! image not scanned: ${s.ref} (${s.reason})${c.reset}`);
  }
  selected.push(...imageScanners(imagePlan.images, delegates));
  return selected;
}

/**
 * Air-gap posture from `.kit.toml [air_gap]` + env (env overrides). When enabled, drop cloud-only
 * scanners and run the rest against local DBs with no network. See docs/AIR_GAP.md.
 * Returns null when a threat-data bundle cannot be verified (fail-closed).
 */
async function applyAirGap(selected: ScannerDef[], config: kitConfig): Promise<AirGapPlan | null> {
  const { airGapScanners } = await import("../scanners.js");
  const { resolveAirGap } = await import("../airgap/config.js");
  const ag = resolveAirGap(config.air_gap, process.env);
  const airgap = airGapScanners(selected, ag.enabled);
  if (!ag.enabled) return airgap;
  console.log(
    `${c.dim}air-gap mode: offline scanners only${airgap.dropped.length ? ` (skipping cloud-only: ${airgap.dropped.join(", ")})` : ""}${c.reset}`,
  );
  await warnRegistrySemgrep();
  if (!ag.threatDataDir) return airgap;
  const env = await verifiedThreatDataEnv(ag.threatDataDir, ag.threatDataPubkey ?? "");
  if (!env) return null;
  Object.assign(airgap.env, env);
  return airgap;
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
 * local DB set. Fail-closed — never scan against unverified threat data. Returns the env the
 * bundle sets, or null when it cannot be verified.
 */
async function verifiedThreatDataEnv(
  tdDir: string,
  pubRef: string,
): Promise<Record<string, string> | null> {
  const { verifyThreatData } = await import("../airgap/threat-data.js");
  const pubPem = pubRef && existsSync(pubRef) ? readFileSync(pubRef, "utf8") : pubRef;
  if (!pubPem) {
    console.error(
      `${c.red}✗ air-gap threat-data dir set but no public key (threat_data_pubkey / KIT_THREAT_DATA_PUBKEY) — cannot verify (fail-closed)${c.reset}`,
    );
    return null;
  }
  const res = verifyThreatData({
    dir: tdDir,
    publicKeyPem: pubPem,
    readFile: (rel) => readFileSync(resolve(tdDir, rel)),
    resolvePath: (rel) => resolve(tdDir, rel),
  });
  if (!res.ok) {
    console.error(`${c.red}✗ threat-data bundle rejected: ${res.reason} (fail-closed)${c.reset}`);
    return null;
  }
  console.log(
    `${c.dim}verified threat-data bundle: ${res.artifacts} artifact(s) signed + checksummed${c.reset}`,
  );
  return res.env;
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
      run: async (bin, args, timeoutMs, projectDir) => {
        const r = await execFileNoThrow(bin, args, {
          timeout: timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
          cwd: projectDir ? resolve(cwd, projectDir) : undefined,
          // A scanner's report grows with what it finds (Semgrep SARIF was 2 MiB on one repo).
          maxBuffer: 64 * 1024 * 1024,
          env: scannerEnv(process.env, { ...airgap.env, ...toolingTokens }, process.cwd()),
        });
        return {
          ok: r.ok,
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          truncated: r.truncated,
          timedOut: r.timedOut,
        };
      },
      hasEnv: (name) => Boolean(process.env[name] || toolingTokens[name]),
      detect: (markers) => hasMarker(cwd, markers),
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

async function judgeScan(
  cwd: string,
  config: kitConfig,
  merged: MergedFinding[],
  runs: ScannerRun[],
): Promise<ScanVerdict> {
  const { suppressBaselined, scanHealthGate } = await import("../scanners.js");
  const { loadBaseline, baselineGet } = await import("../baseline.js");
  const accepted = new Set(baselineGet(await loadBaseline(cwd), "scan", "findings"));
  const { kept: findings, suppressed } = suppressBaselined(merged, accepted);
  const bad = findings.filter((m) => m.severity === "critical" || m.severity === "high").length;

  // Scanner-HEALTH gate (separate from findings): a scanner that did not actually
  // run (crashed/absent/no-token) must be able to force a non-zero exit so a green
  // verdict never hides a broken scanner. Backward-compatible — a non-running
  // scanner stays a loud WARN unless strict or a required scanner missed.
  const strict = hasFlag(process.argv, "--strict") || envTruthy(process.env.KIT_CI_STRICT);
  const requiredScanners = config.governance?.scan?.required_scanners ?? [];
  const gate = scanHealthGate(runs, { strict, requiredScanners });
  return { runs, findings, suppressed, bad, gate, strict, ok: bad === 0 && gate.ok };
}

async function printVerdict(v: ScanVerdict): Promise<void> {
  if (hasFlag(process.argv, "--sarif")) {
    const { toSarif } = await import("../sbom.js");
    console.log(JSON.stringify(toSarif(v.findings), null, 2));
    return;
  }
  if (hasFlag(process.argv, "--json")) {
    const { runs, findings, suppressed, ok, gate, strict } = v;
    console.log(
      JSON.stringify({ runs, findings, suppressed, ok, scannerGate: gate, strict }, null, 2),
    );
    return;
  }
  const suppressNote = v.suppressed > 0 ? `  ${c.dim}(${v.suppressed} baselined)${c.reset}` : "";
  console.log(
    `${c.bold}kit scan${c.reset}  ${c.dim}external scanners → one merged verdict${c.reset}${suppressNote}`,
  );
  printRuns(v.runs);
  console.log("");
  printFindings(v.findings, v.suppressed);
  if (v.bad > 0) console.log(`${c.red}${v.bad} high/critical${c.reset}`);
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

function printFindings(findings: MergedFinding[], suppressed: number): void {
  if (findings.length === 0) {
    console.log(
      `  ${c.green}no findings${suppressed > 0 ? " (after baseline)" : " from the scanners that ran"}${c.reset}`,
    );
    return;
  }
  for (const m of findings) {
    const sev = m.severity ?? "low";
    const color =
      sev === "critical" || sev === "high" ? c.red : sev === "medium" ? c.yellow : c.dim;
    console.log(
      `  ${color}${sev.toUpperCase().padEnd(8)}${c.reset} ${m.name}  ${c.dim}[${m.scanners.join("+")}]${c.reset}`,
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
