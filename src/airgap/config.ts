/**
 * Resolve the effective air-gap posture from `.kit.toml [air_gap]` + env.
 *
 * The checked-in `.kit.toml` makes the enclave config reproducible; env vars
 * (KIT_AIRGAP, KIT_NPM_REGISTRY, …) override it for one-off/CI runs. Pure +
 * deterministic so it is fully testable.
 */
import type { kitConfig } from "../config.js";

export interface AirGapSettings {
  enabled: boolean;
  npmRegistry?: string;
  pypiIndex?: string;
  githubApi?: string;
  dockerRegistry?: string;
  threatDataDir?: string;
  /** Trusted Ed25519 public key — a file path or an inline PEM. */
  threatDataPubkey?: string;
  /** Offline provenance: shipped-in Sigstore trusted_root.json + identity constraints. */
  provenanceTrustedRoot?: string;
  provenanceCertIdentity?: string;
  provenanceCertIssuer?: string;
}

function envTrue(v: string | undefined): boolean {
  return ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());
}

/** env value wins when set (non-empty); otherwise the checked-in config value. */
function pick(envVal: string | undefined, cfgVal: string | undefined): string | undefined {
  const e = envVal?.trim();
  return e ? e : (cfgVal ?? undefined);
}

export function resolveAirGap(
  cfg: kitConfig["air_gap"],
  env: NodeJS.ProcessEnv = process.env,
): AirGapSettings {
  const ag = cfg ?? {};
  return {
    // env KIT_AIRGAP (truthy) OR config enabled; an explicit KIT_AIRGAP=0 does
    // NOT force-disable a config-enabled posture (env only adds), keeping the
    // checked-in enclave config authoritative unless the operator opts in.
    enabled: envTrue(env.KIT_AIRGAP) || ag.enabled === true,
    npmRegistry: pick(env.KIT_NPM_REGISTRY, ag.npm_registry),
    pypiIndex: pick(env.KIT_PYPI_INDEX, ag.pypi_index),
    githubApi: pick(env.KIT_GITHUB_API, ag.github_api),
    dockerRegistry: pick(env.KIT_DOCKER_REGISTRY, ag.docker_registry),
    threatDataDir: pick(env.KIT_THREAT_DATA_DIR, ag.threat_data_dir),
    threatDataPubkey: pick(env.KIT_THREAT_DATA_PUBKEY, ag.threat_data_pubkey),
    provenanceTrustedRoot: pick(env.KIT_PROVENANCE_TRUSTED_ROOT, ag.provenance_trusted_root),
    provenanceCertIdentity: pick(env.KIT_PROVENANCE_CERT_IDENTITY, ag.provenance_cert_identity),
    provenanceCertIssuer: pick(env.KIT_PROVENANCE_CERT_ISSUER, ag.provenance_cert_issuer),
  };
}

/**
 * The `KIT_*` mirror env vars to inject into the triage subprocess so a
 * config-declared mirror is honored (triage.py reads these from its env).
 * Only includes keys that resolved to a value.
 */
export function airGapTriageEnv(s: AirGapSettings): Record<string, string> {
  const e: Record<string, string> = {};
  if (s.npmRegistry) e.KIT_NPM_REGISTRY = s.npmRegistry;
  if (s.pypiIndex) e.KIT_PYPI_INDEX = s.pypiIndex;
  if (s.githubApi) e.KIT_GITHUB_API = s.githubApi;
  if (s.dockerRegistry) e.KIT_DOCKER_REGISTRY = s.dockerRegistry;
  return e;
}

export interface PostureMirrors {
  npmRegistry?: string;
  pypiIndex?: string;
  githubApi?: string;
  dockerRegistry?: string;
  threatDataDir?: string;
}

/**
 * Render the `[air_gap]` block for `.kit.toml` from a setup posture choice.
 * `enabled = false` = connected (cloud scanners allowed); `enabled = true` =
 * enclave (cloud-only scanners dropped) with optional internal mirrors — only
 * non-empty mirror values are emitted. Pure — fixture-tested.
 */
export function airGapTomlBlock(enabled: boolean, mirrors: PostureMirrors = {}): string {
  const lines = ["[air_gap]", `enabled = ${enabled}`];
  if (enabled) {
    const map: [keyof PostureMirrors, string][] = [
      ["npmRegistry", "npm_registry"],
      ["pypiIndex", "pypi_index"],
      ["githubApi", "github_api"],
      ["dockerRegistry", "docker_registry"],
      ["threatDataDir", "threat_data_dir"],
    ];
    for (const [field, key] of map) {
      const v = mirrors[field]?.trim();
      if (v) lines.push(`${key} = "${v}"`);
    }
  }
  return lines.join("\n");
}
