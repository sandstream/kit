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
