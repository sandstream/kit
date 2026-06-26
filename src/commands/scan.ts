// `kit scan` command — extracted from cli.ts (incremental split).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type kitConfig } from "../config.js";
import { c } from "../utils/colors.js";
import { hasFlag, envTruthy } from "../utils/flags.js";
import { resolveConfigPath } from "../cli-shared.js";

export async function cmdScan(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const { runScanners, suppressBaselined, dedupKey, scanHealthGate, isLocalSemgrepConfig } =
    await import("../scanners.js");
  const { resolveToolBin } = await import("../utils/resolveTool.js");
  const { execFileNoThrow } = await import("../utils/execFileNoThrow.js");
  const { loadBaseline, baselineGet, baselineSet, saveBaseline } = await import("../baseline.js");
  const { SCANNERS, airGapScanners } = await import("../scanners.js");
  const cwd = process.cwd();
  // Config-free by design: scanning is project-agnostic, so a missing .kit.toml is
  // NOT an error — fall back to an empty config (air-gap + tooling tokens then come
  // from env). This is what lets `kit scan` run in any repo without `kit init` first.
  const configPath = resolveConfigPath();
  const config = existsSync(configPath) ? await loadConfig(configPath) : ({} as kitConfig);

  // Air-gap posture from `.kit.toml [air_gap]` + env (env overrides). When
  // enabled, drop cloud-only scanners and run the rest against local DBs with no
  // network. See docs/AIR_GAP.md.
  const { resolveAirGap } = await import("../airgap/config.js");
  const ag = resolveAirGap(config.air_gap, process.env);
  const airgap = airGapScanners(SCANNERS, ag.enabled);
  if (ag.enabled) {
    console.log(
      `${c.dim}air-gap mode: offline scanners only${airgap.dropped.length ? ` (skipping cloud-only: ${airgap.dropped.join(", ")})` : ""}${c.reset}`,
    );
    // Loud rejection: a registry KIT_SEMGREP_CONFIG (p/<pack>, r/<rule>, auto)
    // would fetch rules from semgrep.dev = egress, so semgrep is NOT run
    // air-gapped. Only a LOCAL ruleset path enables semgrep offline.
    const semCfg = process.env.KIT_SEMGREP_CONFIG?.trim();
    if (semCfg && !isLocalSemgrepConfig(semCfg)) {
      console.error(
        `${c.yellow}! air-gap: KIT_SEMGREP_CONFIG='${semCfg}' is a registry config (would fetch from the semgrep registry = egress) — semgrep is NOT run air-gapped. Point KIT_SEMGREP_CONFIG at a local ruleset path to enable it offline.${c.reset}`,
      );
    }
    // Verified offline threat-data bundle (optional): point scanners at a
    // signed, integrity-checked local DB set. Fail-closed — never scan against
    // unverified threat data.
    if (ag.threatDataDir) {
      const tdDir = ag.threatDataDir;
      const { verifyThreatData } = await import("../airgap/threat-data.js");
      const pubRef = ag.threatDataPubkey ?? "";
      const pubPem = pubRef && existsSync(pubRef) ? readFileSync(pubRef, "utf8") : pubRef;
      if (!pubPem) {
        console.error(
          `${c.red}✗ air-gap threat-data dir set but no public key (threat_data_pubkey / KIT_THREAT_DATA_PUBKEY) — cannot verify (fail-closed)${c.reset}`,
        );
        return false;
      }
      const res = verifyThreatData({
        dir: tdDir,
        publicKeyPem: pubPem,
        readFile: (rel) => readFileSync(resolve(tdDir, rel)),
        resolvePath: (rel) => resolve(tdDir, rel),
      });
      if (!res.ok) {
        console.error(
          `${c.red}✗ threat-data bundle rejected: ${res.reason} (fail-closed)${c.reset}`,
        );
        return false;
      }
      Object.assign(airgap.env, res.env);
      console.log(
        `${c.dim}verified threat-data bundle: ${res.artifacts} artifact(s) signed + checksummed${c.reset}`,
      );
    }
  }

  // Resolve scanner tokens (SNYK_TOKEN, …) from a configured tooling Infisical
  // project so `kit scan` works without an `infisical run` wrapper (#65). The
  // value flows vault→subprocess env; it is never logged.
  const toolingTokens: Record<string, string> = {};
  const tooling = config.scan?.tooling;
  if (tooling?.project_id) {
    const { fetchInfisicalProjectSecrets } = await import("../secret-backends.js");
    const map = await fetchInfisicalProjectSecrets({
      project_id: tooling.project_id,
      environment: tooling.env,
    });
    for (const s of SCANNERS) {
      if (s.needsToken && !process.env[s.needsToken] && map.has(s.needsToken)) {
        toolingTokens[s.needsToken] = map.get(s.needsToken)!;
      }
    }
  }

  const { merged, runs } = await runScanners(
    {
      resolve: (bin) => resolveToolBin(bin),
      run: async (bin, args) => {
        const r = await execFileNoThrow(bin, args, {
          timeout: 180_000,
          env: { ...process.env, ...airgap.env, ...toolingTokens },
        });
        return { ok: r.ok, stdout: r.stdout };
      },
      hasEnv: (name) => Boolean(process.env[name] || toolingTokens[name]),
      detect: (markers) => markers.some((m) => existsSync(resolve(cwd, m))),
    },
    airgap.scanners,
  );

  // --update-baseline: freeze the current findings as accepted (#59 noise-reduction),
  // reusing the shared .kit-baseline.json under a "scan" category.
  if (hasFlag(process.argv, "--update-baseline")) {
    const bl = await loadBaseline(cwd);
    baselineSet(bl, "scan", "findings", merged.map(dedupKey));
    await saveBaseline(bl, cwd);
    console.log(
      `${c.green}baseline updated${c.reset}  ${c.dim}${merged.length} scan finding(s) accepted into .kit-baseline.json${c.reset}`,
    );
    return true;
  }

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
  const overallOk = bad === 0 && gate.ok;

  if (hasFlag(process.argv, "--sarif")) {
    const { toSarif } = await import("../sbom.js");
    console.log(JSON.stringify(toSarif(findings), null, 2));
    return overallOk;
  }
  if (jsonMode) {
    console.log(
      JSON.stringify(
        { runs, findings, suppressed, ok: overallOk, scannerGate: gate, strict },
        null,
        2,
      ),
    );
    return overallOk;
  }

  const suppressNote = suppressed > 0 ? `  ${c.dim}(${suppressed} baselined)${c.reset}` : "";
  console.log(
    `${c.bold}kit scan${c.reset}  ${c.dim}external scanners → one merged verdict${c.reset}${suppressNote}`,
  );
  for (const r of runs) {
    const mark =
      r.status === "ran"
        ? `${c.green}✓${c.reset}`
        : r.status === "error"
          ? `${c.red}✗${c.reset}`
          : `${c.dim}−${c.reset}`;
    const note = r.status === "ran" ? `${r.findings} finding(s)` : r.status;
    console.log(`  ${mark} ${r.id}  ${c.dim}${note}${c.reset}`);
  }
  console.log("");
  if (findings.length === 0) {
    console.log(
      `  ${c.green}no findings${suppressed > 0 ? " (after baseline)" : " from the scanners that ran"}${c.reset}`,
    );
  } else {
    for (const m of findings) {
      const sev = m.severity ?? "low";
      const color =
        sev === "critical" || sev === "high" ? c.red : sev === "medium" ? c.yellow : c.dim;
      console.log(
        `  ${color}${sev.toUpperCase().padEnd(8)}${c.reset} ${m.name}  ${c.dim}[${m.scanners.join("+")}]${c.reset}`,
      );
    }
  }
  if (bad > 0) console.log(`${c.red}${bad} high/critical${c.reset}`);
  // Honest scanner-health reporting: name WHICH scanner did not run and why.
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
  return overallOk;
}
