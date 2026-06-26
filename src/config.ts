import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { z } from "zod";

export interface ToolConfig {
  [name: string]: string;
}

export interface ServiceConfig {
  login: string;
  check: string;
  link?: string;
  [key: string]: string | undefined;
}

export interface SecretKeyConfig {
  source:
    | "1password"
    | "env"
    | "eas"
    | "config"
    | "dotenvx"
    | "infisical"
    | "bitwarden"
    | "doppler"
    | "vault"
    | "aws-sm"
    | "gcp-sm"
    | "azure-kv";
  ref?: string;
  value?: string;
  name?: string;
  /** HashiCorp Vault: KV v2 path (e.g. "secret/data/myapp/db") */
  vault_path?: string;
  /** HashiCorp Vault: field inside the secret object */
  vault_field?: string;
  /** AWS Secrets Manager: explicit region override (else AWS_REGION) */
  aws_region?: string;
  /** GCP Secret Manager: project (else env GCP_PROJECT/GOOGLE_CLOUD_PROJECT) */
  gcp_project?: string;
  /** GCP Secret Manager: version label (default "latest") */
  gcp_version?: string;
  /** Azure Key Vault: vault name (else env AZURE_KEYVAULT_NAME) */
  azure_vault?: string;
}

export interface InfisicalConfig {
  project_id?: string;
  environment?: string;
  path?: string;
}

export interface SecretsConfig {
  store?:
    | "bitwarden"
    | "1password"
    | "env"
    | "dotenvx"
    | "doppler"
    | "infisical"
    | "vault"
    | "aws-sm"
    | "gcp-sm"
    | "azure-kv";
  template?: string;
  keys?: Record<string, SecretKeyConfig>;
  infisical?: InfisicalConfig;
}

export interface SkillsConfig {
  registry?: string;
  required?: Record<string, string>;
  optional?: Record<string, string>;
}

/**
 * Web search provider configuration
 * Allows agents to use local or alternative search providers
 */
export interface WebSearchConfig {
  provider?: "brave" | "searxng" | "google" | "custom";
  url?: string;
  apiKey?: string;
  /** Google Programmable Search engine id (cx) — required for the google provider. */
  cx?: string;
}

/**
 * Environment-specific access permissions
 * Parsed from [governance.access.dev], [governance.access.staging], [governance.access.prod]
 */
export interface EnvironmentAccess {
  read: boolean;
  write: boolean;
  delete: boolean;
}

/**
 * Access control configuration per environment
 * Parsed from [governance.access]
 */
export interface GovernanceAccessConfig {
  dev?: EnvironmentAccess;
  staging?: EnvironmentAccess;
  prod?: EnvironmentAccess;
}

/**
 * Agent identification and budget limits
 * Parsed from [governance.agent]
 */
export interface GovernanceAgentConfig {
  id?: string;
  name?: string;
  max_tokens_per_day?: number;
  max_operations_per_hour?: number;
}

/**
 * Audit logging configuration
 * Parsed from [governance.audit]
 */
/**
 * Per-MCP-server configuration declared in `.kit.toml [mcp.<name>]`.
 * Each block describes one MCP kit may auth against + the scopes the
 * operator pre-approves for that workspace.
 */
export interface McpServerConfig {
  /** Vendor URL — e.g. https://mcp.sentry.dev, mcp.stripe.com, etc. */
  url?: string;
  /** Region hint (us / eu / self-hosted). */
  region?: string;
  /** Scopes the operator declares kit can request. */
  scopes?: string[];
  /** Optional project/team scope tightener. */
  project?: string;
  /** Optional team-id scope tightener. */
  team?: string;
}

export interface McpConfig {
  [name: string]: McpServerConfig;
}

/**
 * Agent-write pre-approval policy. Declares which sensitive vendor ops the
 * operator pre-authorizes for this repo. Classifiers / agents reading
 * `KIT_POLICY_HASH` know which ops are explicit-OK vs require fresh
 * confirmation. See docs/THREAT_MODEL.md + src/policy.ts.
 *
 * Example:
 *   [policy.agent_writes]
 *   sentry = ["resolve_issue", "create_release"]
 *   supabase = ["rotate_jwt", "list_projects"]
 *   vercel = ["env_set", "trigger_deploy"]
 *   stripe = []  # all writes still gated
 */
export interface PolicyAgentWritesConfig {
  [vendor: string]: string[];
}

export interface PolicyConfig {
  agent_writes?: PolicyAgentWritesConfig;
  /** Force read-only mode for this repo. Same effect as `--read-only` flag. */
  default_mode?: "read-write" | "read-only";
}

export interface GovernanceAuditConfig {
  enabled?: boolean;
  log_file?: string;
  log_level?: "debug" | "info" | "warn" | "error";
  include_secrets?: boolean;
  /**
   * Ship audit events to KIT_REMOTE_URL in addition to the local JSONL.
   * Default false — audit-log is local-first per docs/THREAT_MODEL.md. The
   * first remote-push attempt emits a loud stderr notice so operators know
   * data is leaving the machine.
   */
  remote?: boolean;
  /**
   * Fail-closed anchoring for `kit audit verify`. When true, an unanchored log,
   * an unreadable anchor key, an unsealed tail, or a rotated key are treated as
   * verification FAILURES (non-zero exit) instead of warnings. Defaults to
   * false for backward compatibility (and is implicitly active once this
   * machine has anchored any log). See docs/AUDIT_ATTESTATION.md.
   */
  require_anchor?: boolean;
}

/**
 * Approval gate configuration for destructive operations
 * Parsed from [governance.approval]
 */
export interface GovernanceApprovalConfig {
  destructive_operations?: string[];
  production_writes?: boolean;
  secret_rotations?: boolean;
  approval_timeout?: number;
}

/**
 * Secret lifecycle management configuration
 * Parsed from [governance.secrets]
 */
export interface GovernanceSecretsConfig {
  check_expiration?: boolean;
  warn_days_before_expiry?: number;
  rotate_on_expiry?: boolean;
  revoke_on_agent_disable?: boolean;
}

/**
 * Emergency access revocation configuration
 * Parsed from [governance.revocation]
 */
export interface GovernanceRevocationConfig {
  enabled?: boolean;
  check_interval?: number;
  revocation_endpoint?: string;
}

/**
 * Complete governance configuration
 * Parsed from [governance] and sub-sections
 * See GOVERNANCE.md for complete documentation
 */
export interface GovernanceConfig {
  enabled?: boolean;
  environment?: "dev" | "staging" | "prod";
  access?: GovernanceAccessConfig;
  agent?: GovernanceAgentConfig;
  audit?: GovernanceAuditConfig;
  approval?: GovernanceApprovalConfig;
  secrets?: GovernanceSecretsConfig;
  revocation?: GovernanceRevocationConfig;
  /**
   * Scan-gate policy. `required_scanners` lists scanner ids (snyk/trivy/grype/
   * semgrep/osv-scanner/socket) that MUST actually run — if a required scanner
   * crashed, is absent, or is missing its token, the scan exits non-zero instead
   * of false-greening on findings alone. Parsed from [governance.scan].
   */
  scan?: GovernanceScanConfig;
}

/**
 * Scan-gate policy.
 * Parsed from [governance.scan]
 */
export interface GovernanceScanConfig {
  required_scanners?: string[];
}

/**
 * Git hooks configuration
 * Parsed from [hooks]
 */
export interface HooksConfig {
  "pre-commit"?: string[];
  "pre-push"?: string[];
  "post-commit"?: string[];
  "post-merge"?: string[];
  [hookName: string]: string[] | undefined;
}

/** Per-environment overrides — a partial kitConfig without nested env sections */
export interface EnvOverride {
  tools?: ToolConfig;
  services?: Record<string, ServiceConfig>;
  secrets?: SecretsConfig;
  skills?: SkillsConfig;
  governance?: GovernanceConfig;
}

/**
 * Per-project CLI context lock. Each tool declares the EXACT (account, project)
 * pair this repo must use. kit verifies the live tool state against these
 * declarations and never infers a pairing from whatever happens to be logged in
 * or selected (a logged-in account + a selected project are not assumed to belong
 * together). These are non-secret pointers; the credentials they authenticate
 * with stay in the vault (`[secrets]`).
 */
export interface ContextConfig {
  gcloud?: { account?: string; project?: string; config?: string; region?: string };
  vercel?: { team?: string; project?: string };
  github?: { org?: string; remote?: string };
  gitlab?: { group?: string; remote?: string };
  bitbucket?: { workspace?: string; remote?: string };
  /** SSH identity this repo must push/deploy with. Declare any of these. */
  ssh?: { identity?: string; fingerprint?: string; host_alias?: string };
  git?: { email?: string };
  npm?: { registry?: string };
  /**
   * App-service auth identity — guards "dev pointed at prod". Declares which
   * Keycloak realm / Auth0 tenant / Clerk environment this repo must run against;
   * `kit context check` reads the live value from the app's env and verifies it.
   */
  keycloak?: { realm?: string };
  auth0?: { tenant?: string };
  clerk?: { env?: string };
}

/** [setup] — project bootstrap commands run by `kit setup`. install/verify run
 *  by default; migrate/seed are opt-in (may mutate a real DB). */
export interface SetupConfig {
  /** Default setup mode preset: full | local | airgap | ci | agent | review | minimal. */
  mode?: string;
  install?: string;
  migrate?: string;
  seed?: string;
  verify?: string;
}

/**
 * The current/baseline .kit.toml schema version. A config with no [version]
 * field is treated as legacy "v0" (every config written before versioning
 * existed). `kit config migrate` walks a config from its detected version up to
 * this value. Bump this (and add a migration row in config-migrate.ts) whenever a
 * breaking config-shape change lands — never silently re-interpret old configs.
 */
export const CONFIG_SCHEMA_VERSION = 1;

export interface kitConfig {
  /**
   * Schema version of this .kit.toml. Absent => legacy v0 (migrate stamps it).
   * Single integer (not a [meta] table): .kit.toml is entirely kit's namespace,
   * so a top-level scalar is unambiguous and is the smallest possible addition
   * needed to freeze the config contract.
   */
  version?: number;
  tools?: ToolConfig;
  services?: Record<string, ServiceConfig>;
  /** Project bootstrap commands (deps install, migrate, verify). */
  setup?: SetupConfig;
  secrets?: SecretsConfig;
  skills?: SkillsConfig;
  governance?: GovernanceConfig;
  hooks?: HooksConfig;
  /** Per-project CLI context lock (account+project per tool). */
  context?: ContextConfig;
  /** Install-time supply-chain triage settings (`kit supply-chain`). */
  supply_chain?: { internal_scopes?: string[] };
  /** `kit scan` / `kit check` scanner settings. `tooling` = an Infisical project to
   *  resolve scanner tokens (SNYK_TOKEN, …) from; `guarddog` = enable the local
   *  behavioral-malware scan in `kit check` (persistent alt to KIT_GUARDDOG=1). */
  scan?: { tooling?: { project_id?: string; env?: string }; guarddog?: boolean };
  /**
   * No-egress / air-gapped posture (declarative; see docs/AIR_GAP.md). Equivalent
   * to the `KIT_*` env vars, but checked in so the enclave config is reproducible.
   * Env vars, when set, override these. `enabled` turns on offline scan mode.
   */
  air_gap?: {
    enabled?: boolean;
    npm_registry?: string;
    pypi_index?: string;
    github_api?: string;
    docker_registry?: string;
    threat_data_dir?: string;
    threat_data_pubkey?: string;
    /** Offline provenance (`kit verify-provenance`): shipped-in Sigstore trust + identity constraints. */
    provenance_trusted_root?: string;
    provenance_cert_identity?: string;
    provenance_cert_issuer?: string;
  };
  web?: {
    search?: WebSearchConfig;
  };
  /** Named environment overrides: [env.staging.*], [env.production.*] */
  env?: Record<string, EnvOverride>;
  /** Declared MCP-server connections. See McpConfig + src/mcp-orchestrator.ts. */
  mcp?: McpConfig;
  /** Agent-write pre-approval policy. See PolicyConfig + src/policy.ts. */
  policy?: PolicyConfig;
  /** Memory/PAL behavior. `track_findings` (default true): auto-track `kit check`
   *  findings as PAL items for cross-session reminders + auto-close on re-scan. */
  memory?: { track_findings?: boolean };
  /** Update behavior. `check` (default true): surface a newer published kit in
   *  `kit check` + the update banner. (Set false, or KIT_NO_UPDATE_CHECK=1.)
   *  `auto` (default false, opt-in): when a newer kit is found during `kit check`,
   *  run the GOVERNED self-upgrade — triage kit's own package first and install
   *  ONLY on a triage PASS (never on fail/offline). Stays off by default because
   *  auto-installing is a deliberate trust decision. */
  update?: { check?: boolean; auto?: boolean };
}

// ─── Zod validation schemas ──────────────────────────────────────────────────
// Use .passthrough() at every level for forward compatibility: unknown keys
// are allowed (no error), but wrong types on known keys are caught.

const SecretKeyConfigSchema = z
  .object({
    source: z.enum([
      "1password",
      "env",
      "eas",
      "config",
      "dotenvx",
      "infisical",
      "bitwarden",
      "doppler",
      "vault",
      "aws-sm",
      "gcp-sm",
      "azure-kv",
    ]),
    ref: z.string().optional(),
    value: z.string().optional(),
    name: z.string().optional(),
    vault_path: z.string().optional(),
    vault_field: z.string().optional(),
    aws_region: z.string().optional(),
    gcp_project: z.string().optional(),
    gcp_version: z.string().optional(),
    azure_vault: z.string().optional(),
  })
  .passthrough();

const SecretsConfigSchema = z
  .object({
    store: z
      .enum([
        "bitwarden",
        "1password",
        "env",
        "dotenvx",
        "doppler",
        "infisical",
        "vault",
        "aws-sm",
        "gcp-sm",
        "azure-kv",
      ])
      .optional(),
    template: z.string().optional(),
    keys: z.record(z.string(), SecretKeyConfigSchema).optional(),
    infisical: z
      .object({
        project_id: z.string().optional(),
        environment: z.string().optional(),
        path: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ServiceConfigSchema = z
  .object({
    login: z.string(),
    check: z.string(),
    link: z.string().optional(),
    /** How kit obtains this service's credential. Inferred when omitted
     * (interactive if a login command exists, else vault). See service-auth.ts. */
    auth: z.enum(["vault", "capture", "interactive"]).optional(),
  })
  .passthrough();

const SkillsConfigSchema = z
  .object({
    registry: z.string().optional(),
    required: z.record(z.string(), z.string()).optional(),
    optional: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const GovernanceConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    environment: z.enum(["dev", "staging", "prod"]).optional(),
    access: z
      .object({
        dev: z
          .object({ read: z.boolean(), write: z.boolean(), delete: z.boolean() })
          .passthrough()
          .optional(),
        staging: z
          .object({ read: z.boolean(), write: z.boolean(), delete: z.boolean() })
          .passthrough()
          .optional(),
        prod: z
          .object({ read: z.boolean(), write: z.boolean(), delete: z.boolean() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    agent: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        max_tokens_per_day: z.number().optional(),
        max_operations_per_hour: z.number().optional(),
      })
      .passthrough()
      .optional(),
    audit: z
      .object({
        enabled: z.boolean().optional(),
        log_file: z.string().optional(),
        log_level: z.enum(["debug", "info", "warn", "error"]).optional(),
        include_secrets: z.boolean().optional(),
        require_anchor: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    approval: z
      .object({
        destructive_operations: z.array(z.string()).optional(),
        production_writes: z.boolean().optional(),
        secret_rotations: z.boolean().optional(),
        approval_timeout: z.number().optional(),
      })
      .passthrough()
      .optional(),
    secrets: z
      .object({
        check_expiration: z.boolean().optional(),
        warn_days_before_expiry: z.number().optional(),
        rotate_on_expiry: z.boolean().optional(),
        revoke_on_agent_disable: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    revocation: z
      .object({
        enabled: z.boolean().optional(),
        check_interval: z.number().optional(),
        revocation_endpoint: z.string().optional(),
      })
      .passthrough()
      .optional(),
    scan: z
      .object({
        required_scanners: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const HooksConfigSchema = z.record(z.string(), z.array(z.string()).optional()).optional();

const WebConfigSchema = z
  .object({
    search: z
      .object({
        provider: z.enum(["brave", "searxng", "google", "custom"]).optional(),
        url: z.string().optional(),
        apiKey: z.string().optional(),
        cx: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .optional();

// Known top-level section names — used to detect typos
// Exported as part of kit's frozen config surface (contracts/public-surface.json).
// The breaking-change detector snapshots these section names; adding/removing one
// is a config-schema change that must be reflected in the committed snapshot.
export const KNOWN_SECTIONS = new Set([
  "version", // top-level schema-version scalar (kit config migrate)
  "tools",
  "services",
  "secrets",
  "skills",
  "governance",
  "hooks",
  "web",
  "setup",
  "env",
  "context",
  "memory",
  "update",
  "scan", // [scan.tooling] — vault-backed scanner tokens (#65)
  "air_gap", // [air_gap] — no-egress / offline config (#85)
]);

export const kitConfigSchema = z
  .object({
    version: z.number().int().nonnegative().optional(),
    tools: z.record(z.string(), z.string()).optional(),
    services: z.record(z.string(), ServiceConfigSchema).optional(),
    secrets: SecretsConfigSchema.optional(),
    skills: SkillsConfigSchema.optional(),
    governance: GovernanceConfigSchema.optional(),
    hooks: HooksConfigSchema,
    context: z
      .object({
        gcloud: z
          .object({
            account: z.string().optional(),
            project: z.string().optional(),
            config: z.string().optional(),
            region: z.string().optional(),
          })
          .passthrough()
          .optional(),
        vercel: z
          .object({ team: z.string().optional(), project: z.string().optional() })
          .passthrough()
          .optional(),
        github: z
          .object({ org: z.string().optional(), remote: z.string().optional() })
          .passthrough()
          .optional(),
        gitlab: z
          .object({ group: z.string().optional(), remote: z.string().optional() })
          .passthrough()
          .optional(),
        bitbucket: z
          .object({ workspace: z.string().optional(), remote: z.string().optional() })
          .passthrough()
          .optional(),
        ssh: z
          .object({
            identity: z.string().optional(),
            fingerprint: z.string().optional(),
            host_alias: z.string().optional(),
          })
          .passthrough()
          .optional(),
        git: z.object({ email: z.string().optional() }).passthrough().optional(),
        npm: z.object({ registry: z.string().optional() }).passthrough().optional(),
        keycloak: z.object({ realm: z.string().optional() }).passthrough().optional(),
        auth0: z.object({ tenant: z.string().optional() }).passthrough().optional(),
        clerk: z.object({ env: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    supply_chain: z
      .object({ internal_scopes: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    scan: z
      .object({
        tooling: z
          .object({ project_id: z.string().optional(), env: z.string().optional() })
          .passthrough()
          .optional(),
        guarddog: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    air_gap: z
      .object({
        enabled: z.boolean().optional(),
        npm_registry: z.string().optional(),
        pypi_index: z.string().optional(),
        github_api: z.string().optional(),
        docker_registry: z.string().optional(),
        threat_data_dir: z.string().optional(),
        threat_data_pubkey: z.string().optional(),
        provenance_trusted_root: z.string().optional(),
        provenance_cert_identity: z.string().optional(),
        provenance_cert_issuer: z.string().optional(),
      })
      .passthrough()
      .optional(),
    web: WebConfigSchema,
    setup: z
      .object({
        mode: z.string().optional(),
        install: z.string().optional(),
        migrate: z.string().optional(),
        seed: z.string().optional(),
        verify: z.string().optional(),
      })
      .passthrough()
      .optional(),
    memory: z
      .object({
        track_findings: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    update: z
      .object({
        check: z.boolean().optional(),
        auto: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough(); // allow unknown top-level keys (warn, not error)

/**
 * Format Zod validation errors into human-readable messages.
 */
function formatValidationErrors(errors: z.ZodIssue[]): string {
  return errors
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  • ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Detect the active environment name from CLI args, env vars, or NODE_ENV.
 * Resolution order:
 *   1. --env=<name> CLI flag
 *   2. KIT_ENV environment variable
 *   3. NODE_ENV (development→dev, production→prod, test→test)
 *   4. "dev" default
 */
export function resolveActiveEnvironment(cliArgs: string[] = process.argv.slice(2)): string {
  const flag = cliArgs.find((a) => a.startsWith("--env="));
  if (flag) return flag.split("=")[1];

  if (process.env.KIT_ENV) return process.env.KIT_ENV;

  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === "production") return "prod";
  if (nodeEnv === "development") return "dev";
  if (nodeEnv) return nodeEnv;

  return "dev";
}

/**
 * Merge a base kitConfig with an environment-specific override.
 * Override values take precedence; missing override keys fall back to base.
 */
export function mergeEnvironmentConfig(base: kitConfig, override: EnvOverride): kitConfig {
  return {
    ...base,
    tools: override.tools ?? base.tools,
    services: override.services
      ? { ...(base.services ?? {}), ...override.services }
      : base.services,
    secrets: override.secrets ?? base.secrets,
    skills: override.skills ?? base.skills,
    governance: override.governance ?? base.governance,
  };
}

export async function loadConfig(path: string, envName?: string): Promise<kitConfig> {
  const content = await readFile(path, "utf-8");
  const raw = parse(content) as Record<string, unknown>;

  // Validate — surface friendly errors for wrong types, invalid enum values, etc.
  const result = kitConfigSchema.safeParse(raw);

  if (!result.success) {
    const formatted = formatValidationErrors(result.error.issues);
    throw new Error(`Invalid .kit.toml:\n${formatted}`);
  }

  // Warn about unknown top-level sections (likely typos like [tolls] vs [tools])
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SECTIONS.has(key)) {
      console.warn(
        `Warning: unknown section [${key}] in .kit.toml (known: ${[...KNOWN_SECTIONS].join(", ")})`,
      );
    }
  }

  const base = result.data as unknown as kitConfig;

  // Apply environment override if requested and available
  const activeEnv = envName ?? resolveActiveEnvironment();
  const override = base.env?.[activeEnv];
  if (override && activeEnv !== "dev") {
    return mergeEnvironmentConfig(base, override);
  }

  return base;
}
