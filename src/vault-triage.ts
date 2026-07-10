/**
 * kit — vault-config triage (Pillar 4 BYO-gap).
 *
 * `kit triage vault-config` closes the last BYO-triage gap: kit triages the packages, images,
 * skills, MCP servers and plugins you bring, but not the *secret-backend selection* itself —
 * the `secrets.store` and per-key `source` declared in `.kit.toml`. A typo'd or unsupported
 * backend id silently means "no vault", and a plaintext/local source for a shared secret is a
 * lower-assurance choice worth surfacing.
 *
 * This is deterministic, zero-LLM, and touches ONLY the backend SELECTION — never a secret
 * value (kit never reads plaintext secrets; the `.env*` write-gate stays in force). The pure
 * classification lives here; only the command reads `.kit.toml`.
 */
import { BACKENDS } from "./secret-backends.js";
import type { SecretsConfig } from "./config.js";

export type BackendAssurance = "vault-backed" | "local-plaintext" | "unknown";

export interface VaultConfigFinding {
  /** "store" (the global default) or "key:<NAME>" (a per-key override). */
  scope: string;
  /** The configured backend id. */
  source: string;
  assurance: BackendAssurance;
  note: string;
}

export interface VaultTriageResult {
  findings: VaultConfigFinding[];
  /** Fails only on an UNKNOWN backend id (a typo / unsupported backend = silently no vault). A
   *  local-plaintext source is surfaced but not a failure — it's a legitimate dev choice. */
  passed: boolean;
}

/** Local/plaintext-assurance sources: values come from the local env/files, not a vault. */
const LOCAL_PLAINTEXT = new Set(["env", "dotenvx", "config"]);

/** Classify a backend id by assurance. Unknown = not a registered kit backend. */
export function classifyBackend(source: string): BackendAssurance {
  if (!(source in BACKENDS)) return "unknown";
  if (LOCAL_PLAINTEXT.has(source)) return "local-plaintext";
  return "vault-backed";
}

function noteFor(assurance: BackendAssurance): string {
  switch (assurance) {
    case "vault-backed":
      return "vault-backed";
    case "local-plaintext":
      return "local/plaintext source — fine for dev; prefer a vault backend for shared/prod";
    case "unknown":
      return `unknown backend id (known: ${Object.keys(BACKENDS).sort().join(", ")})`;
  }
}

/**
 * Triage a project's secret-backend selection. Pure + deterministic: same config → same
 * findings (sorted store-first, then keys by name). Empty when nothing is configured.
 */
export function triageVaultConfig(secrets: SecretsConfig | undefined): VaultTriageResult {
  const findings: VaultConfigFinding[] = [];
  if (secrets?.store) {
    const assurance = classifyBackend(secrets.store);
    findings.push({ scope: "store", source: secrets.store, assurance, note: noteFor(assurance) });
  }
  for (const [name, cfg] of Object.entries(secrets?.keys ?? {})) {
    const source = cfg?.source;
    if (!source) continue;
    const assurance = classifyBackend(source);
    findings.push({ scope: `key:${name}`, source, assurance, note: noteFor(assurance) });
  }
  findings.sort((a, b) => {
    if (a.scope === "store") return b.scope === "store" ? 0 : -1;
    if (b.scope === "store") return 1;
    return a.scope.localeCompare(b.scope);
  });
  return { findings, passed: !findings.some((f) => f.assurance === "unknown") };
}
