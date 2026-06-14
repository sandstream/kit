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
};

/**
 * Merge user config with defaults (synchronous version)
 */
export function mergeGovernanceConfig(
  userConfig?: GovernanceConfig,
): Required<GovernanceConfig> {
  if (!userConfig) {
    return DEFAULT_GOVERNANCE;
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
  };
}

/**
 * Merge user config with defaults and detect environment (async version)
 */
export async function mergeGovernanceConfigAsync(
  userConfig?: GovernanceConfig,
): Promise<Required<GovernanceConfig>> {
  const merged = mergeGovernanceConfig(userConfig);

  // If environment is not explicitly set, detect it
  if (!userConfig?.environment) {
    merged.environment = await getCurrentEnvironment(userConfig);
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
        const requiresApproval =
          env === "prod" && config.approval.production_writes;
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
export async function getCurrentGitBranch(): Promise<string | null> {
  try {
    const { execSync } = await import("node:child_process");
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
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
export function detectEnvironmentFromBranch(
  branch: string,
): "dev" | "staging" | "prod" | null {
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
  if (
    lowerBranch === "staging" ||
    lowerBranch === "stage" ||
    lowerBranch.startsWith("release/")
  ) {
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
): Promise<"dev" | "staging" | "prod"> {
  // 1. Explicit config takes precedence
  if (config?.environment) {
    return config.environment;
  }

  // 2. NODE_ENV environment variable
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  if (nodeEnv === "production") return "prod";
  if (nodeEnv === "staging") return "staging";
  if (nodeEnv === "development") return "dev";

  // 3. Git branch detection
  const branch = await getCurrentGitBranch();
  if (branch) {
    const envFromBranch = detectEnvironmentFromBranch(branch);
    if (envFromBranch) {
      return envFromBranch;
    }
  }

  // 4. Default to dev
  return "dev";
}

/**
 * Format governance status for display
 */
export function formatGovernanceStatus(
  config: Required<GovernanceConfig>,
): string {
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
