import type { GovernanceConfig, EnvironmentAccess } from "./config.js";

export type OperationType = "read" | "write" | "delete";

export interface GovernanceCheckResult {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
}

/**
 * Default environment access configurations
 */
const DEFAULT_ACCESS: Record<string, EnvironmentAccess> = {
  dev: { read: true, write: true, delete: true },
  staging: { read: true, write: true, delete: false },
  prod: { read: true, write: false, delete: false },
};

/**
 * Default governance configuration
 */
export const DEFAULT_GOVERNANCE: Required<GovernanceConfig> = {
  enabled: false,
  environment: "dev",
  access: DEFAULT_ACCESS,
  agent: {
    id: undefined,
    name: undefined,
    max_tokens_per_day: 1000000,
    max_operations_per_hour: 100,
  },
  audit: {
    enabled: true,
    log_file: ".kit-audit.jsonl",
    log_level: "info",
    include_secrets: false,
  },
  approval: {
    destructive_operations: ["delete", "drop", "truncate", "destroy", "remove"],
    production_writes: true,
    secret_rotations: false,
    approval_timeout: 3600,
  },
  secrets: {
    check_expiration: true,
    warn_days_before_expiry: 30,
    rotate_on_expiry: false,
    revoke_on_agent_disable: true,
  },
  revocation: {
    enabled: false,
    check_interval: 300,
    revocation_endpoint: undefined,
  },
  scan: {
    required_scanners: [],
  },
  containment: {
    require: false,
  },
};

/**
 * Merge user config with defaults (synchronous version)
 */
export function mergeGovernanceConfig(userConfig?: GovernanceConfig): Required<GovernanceConfig> {
  if (!userConfig) {
    // A COPY, not the shared object. Returning DEFAULT_GOVERNANCE by reference meant any
    // caller that mutated the result poisoned the defaults for every later caller in the
    // process — pushing one keyword onto `approval.destructive_operations` changed the
    // gate for everything downstream. The configured path already returns a fresh object
    // via spreads, so only the no-config path leaked the singleton.
    return structuredClone(DEFAULT_GOVERNANCE);
  }

  return {
    enabled: userConfig.enabled ?? DEFAULT_GOVERNANCE.enabled,
    environment: userConfig.environment ?? DEFAULT_GOVERNANCE.environment,
    access: {
      ...DEFAULT_GOVERNANCE.access,
      ...userConfig.access,
    },
    agent: {
      ...DEFAULT_GOVERNANCE.agent,
      ...userConfig.agent,
      max_tokens_per_day:
        userConfig.agent?.max_tokens_per_day === undefined
          ? DEFAULT_GOVERNANCE.agent.max_tokens_per_day
          : userConfig.agent.max_tokens_per_day,
      max_operations_per_hour:
        userConfig.agent?.max_operations_per_hour === undefined
          ? DEFAULT_GOVERNANCE.agent.max_operations_per_hour
          : userConfig.agent.max_operations_per_hour,
    },
    audit: {
      ...DEFAULT_GOVERNANCE.audit,
      ...userConfig.audit,
    },
    approval: {
      ...DEFAULT_GOVERNANCE.approval,
      ...userConfig.approval,
    },
    secrets: {
      ...DEFAULT_GOVERNANCE.secrets,
      ...userConfig.secrets,
    },
    revocation: {
      ...DEFAULT_GOVERNANCE.revocation,
      ...userConfig.revocation,
    },
    scan: {
      ...DEFAULT_GOVERNANCE.scan,
      ...userConfig.scan,
    },
    containment: {
      ...DEFAULT_GOVERNANCE.containment,
      ...userConfig.containment,
    },
  };
}

/**
 * Merge user config with defaults and detect environment (async version)
 */
export async function mergeGovernanceConfigAsync(
  userConfig?: GovernanceConfig,
  cwd?: string,
): Promise<Required<GovernanceConfig>> {
  const merged = mergeGovernanceConfig(userConfig);

  // If environment is not explicitly set, detect it
  if (!userConfig?.environment) {
    merged.environment = await getCurrentEnvironment(userConfig, cwd);
  }

  return merged;
}

/**
 * Check if an operation is allowed based on governance rules
 */
export function checkOperationAllowed(
  config: Required<GovernanceConfig>,
  operation: OperationType,
): GovernanceCheckResult {
  if (!config.enabled) {
    return { allowed: true };
  }

  const env = config.environment;
  const access = config.access[env];

  if (!access) {
    return {
      allowed: false,
      reason: `No access configuration for environment: ${env}`,
    };
  }

  switch (operation) {
    case "read":
      if (!access.read) {
        return {
          allowed: false,
          reason: `Read operations not allowed in ${env} environment`,
        };
      }
      break;

    case "write":
      if (!access.write) {
        const requiresApproval = env === "prod" && config.approval.production_writes;
        if (requiresApproval) {
          return {
            allowed: false,
            requiresApproval: true,
            reason: `Write operations in ${env} require approval`,
          };
        }
        return {
          allowed: false,
          reason: `Write operations not allowed in ${env} environment`,
        };
      }
      break;

    case "delete":
      if (!access.delete) {
        return {
          allowed: false,
          requiresApproval: true,
          reason: `Delete operations not allowed in ${env} environment`,
        };
      }
      break;
  }

  return { allowed: true };
}

/**
 * Check if a command contains destructive operations
 */
export function isDestructiveOperation(
  config: Required<GovernanceConfig>,
  command: string,
): boolean {
  const keywords = config.approval.destructive_operations || [];
  const lowerCommand = command.toLowerCase();

  return keywords.some((keyword) => lowerCommand.includes(keyword.toLowerCase()));
}

/**
 * Get current git branch
 */
export async function getCurrentGitBranch(cwd?: string): Promise<string | null> {
  try {
    const { execFileSync } = await import("node:child_process");
    const env = { ...process.env };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_PREFIX",
    ])
      delete env[key];
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      env,
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return branch;
  } catch {
    return null;
  }
}

/**
 * Detect environment from git branch
 */
export function detectEnvironmentFromBranch(branch: string): "dev" | "staging" | "prod" | null {
  const lowerBranch = branch.toLowerCase();

  // Production branches
  if (
    lowerBranch === "main" ||
    lowerBranch === "master" ||
    lowerBranch === "prod" ||
    lowerBranch === "production"
  ) {
    return "prod";
  }

  // Staging branches
  if (lowerBranch === "staging" || lowerBranch === "stage" || lowerBranch.startsWith("release/")) {
    return "staging";
  }

  // Development branches (all others)
  return "dev";
}

/**
 * Get current environment from config, environment variable, or git branch
 * Priority: config.environment > NODE_ENV > git branch > default (dev)
 */
export async function getCurrentEnvironment(
  config?: GovernanceConfig,
  cwd?: string,
): Promise<"dev" | "staging" | "prod"> {
  return (await getCurrentEnvironmentInfo(config, cwd)).environment;
}

export interface GovernanceEnvironmentInfo {
  environment: "dev" | "staging" | "prod";
  source: "config" | "env" | "git" | "default";
}

/** Return the access environment and the source of that decision. */
export async function getCurrentEnvironmentInfo(
  config?: GovernanceConfig,
  cwd?: string,
): Promise<GovernanceEnvironmentInfo> {
  // 1. Explicit config takes precedence
  if (config?.environment) {
    return { environment: config.environment, source: "config" };
  }

  // 2. NODE_ENV environment variable
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  if (nodeEnv === "production") return { environment: "prod", source: "env" };
  if (nodeEnv === "staging") return { environment: "staging", source: "env" };
  if (nodeEnv === "development") return { environment: "dev", source: "env" };

  // 3. Git branch detection
  const branch = await getCurrentGitBranch(cwd);
  if (branch) {
    const envFromBranch = detectEnvironmentFromBranch(branch);
    if (envFromBranch) {
      return { environment: envFromBranch, source: "git" };
    }
  }

  // 4. Default to dev
  return { environment: "dev", source: "default" };
}

/**
 * Format governance status for display
 */
export function formatGovernanceStatus(config: Required<GovernanceConfig>): string {
  if (!config.enabled) {
    return "Governance: disabled";
  }

  const env = config.environment;
  const access = config.access[env];

  const permissions: string[] = [];
  if (access?.read) permissions.push("read");
  if (access?.write) permissions.push("write");
  if (access?.delete) permissions.push("delete");

  return `Governance: enabled | Environment: ${env} | Permissions: ${permissions.join(", ")}`;
}
