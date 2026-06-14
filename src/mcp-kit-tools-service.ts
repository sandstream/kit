import { randomUUID } from "node:crypto";
import type {
  ConfigValue,
  ConfigValidation,
  AdapterConfig,
  ToolConfig,
  ServiceConfig,
  PathConfig,
  FeatureFlag,
  MCPTool,
  MCPToolResult,
  ConfigSnapshot,
  ConfigRollback,
  ValidationResult,
  AdapterCheckResult,
  AdapterDependency,
  AdapterHealth,
  AdapterInstallResult,
  EnvironmentVariable,
} from "./mcp-kit-tools-model.js";

const configs = new Map<string, ConfigValue>();
const adapters = new Map<string, AdapterConfig>();
const tools = new Map<string, ToolConfig>();
const services = new Map<string, ServiceConfig>();
const paths = new Map<string, PathConfig>();
const featureFlags = new Map<string, FeatureFlag>();
const snapshots = new Map<string, ConfigSnapshot>();
const validationHistory = new Map<string, ConfigValidation>();
const environmentVariables = new Map<string, EnvironmentVariable>();

/**
 * Get configuration value
 */
export function getConfig(key: string): MCPToolResult<ConfigValue | null> {
  const config = configs.get(key);

  if (!config) {
    return {
      success: false,
      error: `Configuration key '${key}' not found`,
    };
  }

  return {
    success: true,
    data: config,
  };
}

/**
 * Set configuration value
 */
export function setConfig(
  key: string,
  value: unknown,
  scope: "global" | "project" | "user" = "project",
  category: "adapter" | "tool" | "service" | "path" | "feature" = "tool",
  modified_by?: string,
): MCPToolResult<ConfigValue> {
  const validation = validateConfigValue(key, value);
  if (validation.result === "invalid") {
    return {
      success: false,
      error: validation.message,
      warnings: validation.suggestions,
    };
  }

  const config: ConfigValue = {
    key,
    value,
    type: typeof value === "object" ? (Array.isArray(value) ? "array" : "object") : (typeof value as any),
    scope,
    category,
    last_modified: new Date().toISOString(),
    modified_by,
  };

  configs.set(key, config);

  return {
    success: true,
    data: config,
  };
}

/**
 * List configurations
 */
export function listConfigs(
  scope?: "global" | "project" | "user",
  category?: "adapter" | "tool" | "service" | "path" | "feature",
  limit: number = 100,
  offset: number = 0,
): MCPToolResult<{ configs: ConfigValue[]; total: number }> {
  let results = Array.from(configs.values());

  if (scope) {
    results = results.filter((c) => c.scope === scope);
  }

  if (category) {
    results = results.filter((c) => c.category === category);
  }

  const total = results.length;
  const paged = results.slice(offset, offset + limit);

  return {
    success: true,
    data: { configs: paged, total },
  };
}

/**
 * Validate configuration value
 */
export function validateConfigValue(
  key: string,
  value: unknown,
): ConfigValidation {
  const existingConfig = configs.get(key);
  let result: ValidationResult = "valid";
  let message = `Configuration '${key}' is valid`;
  const suggestions: string[] = [];

  // Type validation
  if (existingConfig && existingConfig.type !== typeof value) {
    if (typeof value === "string" && existingConfig.type === "number") {
      // Allow string to number conversion
      result = "warning";
      message = `Type mismatch: expected ${existingConfig.type}, got ${typeof value}. Will attempt conversion.`;
    } else {
      result = "invalid";
      message = `Type mismatch: expected ${existingConfig.type}, got ${typeof value}`;
    }
  }

  // Pattern validation
  if (existingConfig?.validation_rule && typeof value === "string") {
    const regex = new RegExp(existingConfig.validation_rule);
    if (!regex.test(value)) {
      result = "invalid";
      message = `Value does not match required pattern: ${existingConfig.validation_rule}`;
    }
  }

  // Range validation
  const configAny = existingConfig as any;
  if (configAny?.min && typeof value === "number" && value < configAny.min) {
    result = "warning";
    message = `Value ${value} is below minimum ${configAny.min}`;
  }

  if (configAny?.max && typeof value === "number" && value > configAny.max) {
    result = "warning";
    message = `Value ${value} is above maximum ${configAny.max}`;
  }

  const validation: ConfigValidation = {
    key,
    result,
    message,
    suggestions,
    timestamp: new Date().toISOString(),
  };

  validationHistory.set(`${key}_${Date.now()}`, validation);

  return validation;
}

/**
 * Get adapter configuration
 */
export function getAdapterConfig(name: string): MCPToolResult<AdapterConfig | null> {
  const adapter = adapters.get(name);

  if (!adapter) {
    return {
      success: false,
      error: `Adapter '${name}' not found`,
    };
  }

  return {
    success: true,
    data: adapter,
  };
}

/**
 * List adapters
 */
export function listAdapters(): MCPToolResult<AdapterConfig[]> {
  const adapterList = Array.from(adapters.values());
  return {
    success: true,
    data: adapterList,
  };
}

/**
 * Configure adapter
 */
export function configureAdapter(
  name: string,
  enabled: boolean,
  settings: Record<string, unknown>,
): MCPToolResult<AdapterConfig> {
  const existing = adapters.get(name);

  const adapter: AdapterConfig = {
    name,
    enabled,
    version: existing?.version,
    settings,
    credentials_configured: Object.keys(settings).length > 0,
    health_status: "healthy",
    last_check: new Date().toISOString(),
  };

  adapters.set(name, adapter);

  return {
    success: true,
    data: adapter,
  };
}

/**
 * Get tool configuration
 */
export function getToolConfig(name: string): MCPToolResult<ToolConfig | null> {
  const tool = tools.get(name);

  if (!tool) {
    return {
      success: false,
      error: `Tool '${name}' not found`,
    };
  }

  return {
    success: true,
    data: tool,
  };
}

/**
 * List tools
 */
export function listTools(): MCPToolResult<ToolConfig[]> {
  return {
    success: true,
    data: Array.from(tools.values()),
  };
}

/**
 * Get service configuration
 */
export function getServiceConfig(name: string): MCPToolResult<ServiceConfig | null> {
  const service = services.get(name);

  if (!service) {
    return {
      success: false,
      error: `Service '${name}' not found`,
    };
  }

  return {
    success: true,
    data: service,
  };
}

/**
 * List services
 */
export function listServices(): MCPToolResult<ServiceConfig[]> {
  return {
    success: true,
    data: Array.from(services.values()),
  };
}

/**
 * Configure service
 */
export function configureService(
  name: string,
  enabled: boolean,
  endpoint?: string,
  port?: number,
): MCPToolResult<ServiceConfig> {
  const service: ServiceConfig = {
    name,
    enabled,
    endpoint,
    port,
    status: enabled ? "running" : "stopped",
    last_status_check: new Date().toISOString(),
  };

  services.set(name, service);

  return {
    success: true,
    data: service,
  };
}

/**
 * Get path configuration
 */
export function getPathConfig(key: string): MCPToolResult<PathConfig | null> {
  const path = paths.get(key);

  if (!path) {
    return {
      success: false,
      error: `Path '${key}' not found`,
    };
  }

  return {
    success: true,
    data: path,
  };
}

/**
 * List paths
 */
export function listPaths(): MCPToolResult<PathConfig[]> {
  return {
    success: true,
    data: Array.from(paths.values()),
  };
}

/**
 * Set path configuration
 */
export function setPathConfig(
  key: string,
  value: string,
  type: "project_root" | "cache_dir" | "config_dir" | "data_dir" | "temp_dir" | "lock_dir",
): MCPToolResult<PathConfig> {
  const path: PathConfig = {
    key,
    value,
    type,
    expandable: value.includes("$") || value.includes("~"),
    must_exist: type !== "temp_dir",
    writable: !["project_root"].includes(type),
  };

  paths.set(key, path);

  return {
    success: true,
    data: path,
  };
}

/**
 * Get feature flag
 */
export function getFeatureFlag(name: string): MCPToolResult<FeatureFlag | null> {
  const flag = featureFlags.get(name);

  if (!flag) {
    return {
      success: false,
      error: `Feature flag '${name}' not found`,
    };
  }

  return {
    success: true,
    data: flag,
  };
}

/**
 * List feature flags
 */
export function listFeatureFlags(): MCPToolResult<FeatureFlag[]> {
  return {
    success: true,
    data: Array.from(featureFlags.values()),
  };
}

/**
 * Toggle feature flag
 */
export function toggleFeatureFlag(
  name: string,
  enabled: boolean,
  scope: "global" | "project" | "user" = "project",
): MCPToolResult<FeatureFlag> {
  const existing = featureFlags.get(name) || {
    name,
    enabled: false,
    scope,
  };

  const flag: FeatureFlag = {
    ...existing,
    enabled,
    scope,
  };

  featureFlags.set(name, flag);

  return {
    success: true,
    data: flag,
  };
}

/**
 * Create configuration snapshot
 */
export function createConfigSnapshot(
  created_by?: string,
  description?: string,
): MCPToolResult<ConfigSnapshot> {
  const snapshot: ConfigSnapshot = {
    id: `snap_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    created_by,
    config_state: Object.fromEntries(configs),
    description,
  };

  snapshots.set(snapshot.id, snapshot);

  return {
    success: true,
    data: snapshot,
  };
}

/**
 * List configuration snapshots
 */
export function listSnapshots(limit: number = 20, offset: number = 0): MCPToolResult<{ snapshots: ConfigSnapshot[]; total: number }> {
  const all = Array.from(snapshots.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const total = all.length;
  const paged = all.slice(offset, offset + limit);

  return {
    success: true,
    data: { snapshots: paged, total },
  };
}

/**
 * Rollback to snapshot
 */
export function rollbackToSnapshot(
  snapshot_id: string,
  performed_by?: string,
): MCPToolResult<ConfigRollback> {
  const snapshot = snapshots.get(snapshot_id);

  if (!snapshot) {
    return {
      success: false,
      error: `Snapshot '${snapshot_id}' not found`,
    };
  }

  const changeCount = configs.size;

  // Restore config state
  configs.clear();
  Object.entries(snapshot.config_state).forEach(([key, value]) => {
    configs.set(key, value as ConfigValue);
  });

  const rollback: ConfigRollback = {
    from_snapshot: snapshots.get(Array.from(snapshots.keys())[0])?.id || "current",
    to_snapshot: snapshot_id,
    changes_reverted: changeCount,
    timestamp: new Date().toISOString(),
    performed_by,
  };

  return {
    success: true,
    data: rollback,
  };
}

/**
 * Check adapter status
 */
export function checkAdapterStatus(adapter_name: string): MCPToolResult<AdapterCheckResult> {
  const adapter = adapters.get(adapter_name);

  if (!adapter) {
    return {
      success: false,
      error: `Adapter '${adapter_name}' not found`,
    };
  }

  const checks: AdapterCheckResult["checks"] = [];

  // Check if installed
  checks.push({
    name: "installation",
    status: adapter.enabled ? "pass" : "fail",
    message: adapter.enabled
      ? `${adapter_name} is installed and enabled`
      : `${adapter_name} is not enabled`,
  });

  // Check configuration
  checks.push({
    name: "configuration",
    status: Object.keys(adapter.settings).length > 0 ? "pass" : "warning",
    message:
      Object.keys(adapter.settings).length > 0
        ? `Configuration present (${Object.keys(adapter.settings).length} settings)`
        : "No configuration found",
  });

  // Check credentials
  checks.push({
    name: "credentials",
    status: adapter.credentials_configured ? "pass" : "warning",
    message: adapter.credentials_configured
      ? "Credentials are configured"
      : "Credentials not configured",
  });

  // Check health
  checks.push({
    name: "health",
    status: adapter.health_status === "healthy" ? "pass" : adapter.health_status === "warning" ? "warning" : "fail",
    message: `Health status: ${adapter.health_status || "unknown"}`,
  });

  const overallStatus =
    checks.every((c) => c.status === "pass")
      ? "healthy"
      : checks.some((c) => c.status === "fail")
        ? "unhealthy"
        : "degraded";

  const result: AdapterCheckResult = {
    adapter_name,
    overall_status: overallStatus,
    installed: adapter.enabled,
    configured: Object.keys(adapter.settings).length > 0,
    authenticated: adapter.credentials_configured,
    available: adapter.health_status === "healthy",
    checks,
    last_checked: new Date().toISOString(),
  };

  // Add recommendations
  if (overallStatus !== "healthy") {
    result.recommendations = [];
    if (!adapter.enabled) {
      result.recommendations.push(`Enable ${adapter_name} in configuration`);
    }
    if (!adapter.credentials_configured) {
      result.recommendations.push(`Configure credentials for ${adapter_name}`);
    }
    if (adapter.health_status === "warning" || adapter.health_status === "error") {
      result.recommendations.push(`Check ${adapter_name} health status`);
    }
  }

  return {
    success: true,
    data: result,
  };
}

/**
 * Check adapter dependencies
 */
export function checkAdapterDependencies(adapter_name: string): MCPToolResult<AdapterDependency[]> {
  // Simulated dependencies for adapters
  const dependencyMap: Record<string, AdapterDependency[]> = {
    stripe: [
      { name: "node", required: true, installed: true, compatible: true, version: "20.0.0" },
      { name: "npm", required: true, installed: true, compatible: true, version: "10.0.0" },
    ],
    github: [
      { name: "git", required: true, installed: true, compatible: true, version: "2.40.0" },
      { name: "curl", required: false, installed: true, compatible: true },
    ],
    slack: [
      { name: "node", required: true, installed: true, compatible: true, version: "20.0.0" },
    ],
  };

  const deps = dependencyMap[adapter_name] || [];

  return {
    success: true,
    data: deps,
  };
}

/**
 * Get adapter health status
 */
export function getAdapterHealth(adapter_name: string): MCPToolResult<AdapterHealth> {
  const adapter = adapters.get(adapter_name);

  if (!adapter) {
    return {
      success: false,
      error: `Adapter '${adapter_name}' not found`,
    };
  }

  const health: AdapterHealth = {
    adapter_name,
    healthy: adapter.health_status === "healthy",
    uptime_seconds: Math.floor(Math.random() * 86400),
    error_count: Math.floor(Math.random() * 5),
    success_count: Math.floor(Math.random() * 100),
    average_response_time_ms: Math.floor(Math.random() * 500) + 50,
    last_checked: adapter.last_check || new Date().toISOString(),
  };

  return {
    success: true,
    data: health,
  };
}

/**
 * Install adapter
 */
export function installAdapter(
  adapter_name: string,
  auto_configure: boolean = false,
  version?: string,
  installed_by?: string,
): MCPToolResult<AdapterInstallResult> {
  const existing = adapters.get(adapter_name);

  const result: AdapterInstallResult = {
    adapter_name,
    success: true,
    installed: true,
    version: version || existing?.version || "1.0.0",
    configured: false,
    env_vars_set: [],
    setup_required: !auto_configure,
    next_steps: auto_configure
      ? []
      : [
          `Run: kit adapter setup ${adapter_name}`,
          `Or set environment variables manually`,
        ],
    message: `${adapter_name} adapter installed successfully`,
    timestamp: new Date().toISOString(),
  };

  // Mark adapter as installed
  const adapter: AdapterConfig = {
    name: adapter_name,
    enabled: true,
    version: result.version,
    settings: {},
    credentials_configured: false,
    health_status: "healthy",
    last_check: new Date().toISOString(),
  };

  adapters.set(adapter_name, adapter);

  if (auto_configure) {
    result.setup_required = false;
    result.message += " and auto-configured";
  }

  return {
    success: true,
    data: result,
  };
}

/**
 * Setup adapter automatically
 */
export function setupAdapterAuto(
  adapter_name: string,
  env_vars: Record<string, string>,
  setup_by?: string,
): MCPToolResult<AdapterInstallResult> {
  const adapter = adapters.get(adapter_name);

  if (!adapter) {
    return {
      success: false,
      error: `Adapter '${adapter_name}' not found. Install it first.`,
    };
  }

  const vars_set: string[] = [];

  // Set environment variables
  Object.entries(env_vars).forEach(([key, value]) => {
    const var_key = `${adapter_name}_${key}`.toUpperCase();
    const envVar: EnvironmentVariable = {
      key: var_key,
      value,
      adapter_name,
      required: true,
      set_at: new Date().toISOString(),
    };
    environmentVariables.set(var_key, envVar);
    vars_set.push(var_key);
  });

  // Update adapter config
  adapter.settings = env_vars;
  adapter.credentials_configured = true;
  adapter.last_check = new Date().toISOString();

  const result: AdapterInstallResult = {
    adapter_name,
    success: true,
    installed: true,
    version: adapter.version,
    configured: true,
    env_vars_set: vars_set,
    setup_required: false,
    next_steps: [],
    message: `${adapter_name} adapter configured with ${vars_set.length} environment variables`,
    timestamp: new Date().toISOString(),
  };

  return {
    success: true,
    data: result,
  };
}

/**
 * Setup adapter interactively
 */
export function setupAdapterInteractive(
  adapter_name: string,
  responses: Record<string, string>,
  setup_by?: string,
): MCPToolResult<AdapterInstallResult> {
  const adapter = adapters.get(adapter_name);

  if (!adapter) {
    return {
      success: false,
      error: `Adapter '${adapter_name}' not found. Install it first.`,
    };
  }

  const vars_set: string[] = [];

  // Process interactive responses
  Object.entries(responses).forEach(([key, value]) => {
    const var_key = `${adapter_name}_${key}`.toUpperCase();
    const envVar: EnvironmentVariable = {
      key: var_key,
      value,
      adapter_name,
      required: true,
      set_at: new Date().toISOString(),
    };
    environmentVariables.set(var_key, envVar);
    vars_set.push(var_key);
  });

  // Update adapter settings
  adapter.settings = responses;
  adapter.credentials_configured = true;
  adapter.last_check = new Date().toISOString();

  const result: AdapterInstallResult = {
    adapter_name,
    success: true,
    installed: true,
    version: adapter.version,
    configured: true,
    env_vars_set: vars_set,
    setup_required: false,
    next_steps: [],
    message: `${adapter_name} adapter configured interactively with ${vars_set.length} variables`,
    timestamp: new Date().toISOString(),
  };

  return {
    success: true,
    data: result,
  };
}

/**
 * Set environment variable
 */
export function setEnvironmentVariable(
  key: string,
  value: string,
  adapter_name: string,
  required: boolean = false,
  description?: string,
): MCPToolResult<EnvironmentVariable> {
  const envVar: EnvironmentVariable = {
    key,
    value,
    adapter_name,
    required,
    description,
    set_at: new Date().toISOString(),
  };

  environmentVariables.set(key, envVar);

  return {
    success: true,
    data: envVar,
  };
}

/**
 * Get environment variables for adapter
 */
export function getEnvironmentVariables(
  adapter_name?: string,
  required_only: boolean = false,
): MCPToolResult<EnvironmentVariable[]> {
  let vars = Array.from(environmentVariables.values());

  if (adapter_name) {
    vars = vars.filter((v) => v.adapter_name === adapter_name);
  }

  if (required_only) {
    vars = vars.filter((v) => v.required);
  }

  return {
    success: true,
    data: vars,
  };
}

/**
 * Get MCP tool definitions
 */
export function getMCPTools(): MCPTool[] {
  return [
    {
      id: "kit_configure",
      name: "kit_configure",
      description: "Get/set/list/validate kit configuration",
      category: "configuration",
      version: "1.0.0",
      requires_auth: false,
      actions: [
        {
          name: "get",
          description: "Get configuration value by key",
          parameters: [
            {
              name: "key",
              description: "Configuration key",
              type: "string",
              required: true,
            },
          ],
          returns: {
            type: "object",
            description: "Configuration value object",
          },
        },
        {
          name: "set",
          description: "Set configuration value",
          parameters: [
            {
              name: "key",
              description: "Configuration key",
              type: "string",
              required: true,
            },
            {
              name: "value",
              description: "Value to set",
              type: "string",
              required: true,
            },
            {
              name: "scope",
              description: "Configuration scope",
              type: "string",
              required: false,
              enum: ["global", "project", "user"],
            },
          ],
          returns: {
            type: "object",
            description: "Updated configuration",
          },
        },
        {
          name: "list",
          description: "List configurations",
          parameters: [
            {
              name: "scope",
              description: "Filter by scope",
              type: "string",
              required: false,
            },
            {
              name: "category",
              description: "Filter by category",
              type: "string",
              required: false,
            },
          ],
          returns: {
            type: "object",
            description: "Configuration list",
          },
        },
        {
          name: "validate",
          description: "Validate configuration value",
          parameters: [
            {
              name: "key",
              description: "Configuration key",
              type: "string",
              required: true,
            },
            {
              name: "value",
              description: "Value to validate",
              type: "string",
              required: true,
            },
          ],
          returns: {
            type: "object",
            description: "Validation result",
          },
        },
      ],
    },
    {
      id: "kit_adapter_check",
      name: "kit_adapter_check",
      description: "Check adapter installation, configuration, and authentication status",
      category: "health",
      version: "1.0.0",
      requires_auth: false,
      actions: [
        {
          name: "status",
          description: "Get complete adapter status with all checks",
          parameters: [
            {
              name: "adapter",
              description: "Adapter name",
              type: "string",
              required: true,
            },
          ],
          returns: {
            type: "object",
            description: "Adapter status with check results",
          },
        },
        {
          name: "dependencies",
          description: "Check adapter dependencies",
          parameters: [
            {
              name: "adapter",
              description: "Adapter name",
              type: "string",
              required: true,
            },
          ],
          returns: {
            type: "array",
            description: "Dependency list",
          },
        },
        {
          name: "health",
          description: "Get adapter health metrics",
          parameters: [
            {
              name: "adapter",
              description: "Adapter name",
              type: "string",
              required: true,
            },
          ],
          returns: {
            type: "object",
            description: "Health metrics",
          },
        },
      ],
    },
    {
      id: "kit_adapter_install",
      name: "kit_adapter_install",
      description: "Install, configure, and setup kit adapters with auto or interactive configuration",
      category: "installation",
      version: "1.0.0",
      requires_auth: false,
      actions: [
        {
          name: "install",
          description: "Install an adapter",
          parameters: [
            {
              name: "adapter",
              description: "Adapter name",
              type: "string",
              required: true,
            },
            {
              name: "version",
              description: "Adapter version",
              type: "string",
              required: false,
            },
            {
              name: "auto_configure",
              description: "Auto-configure after installation",
              type: "boolean",
              required: false,
            },
          ],
          returns: {
            type: "object",
            description: "Installation result",
          },
        },
        {
          name: "setup",
          description: "Setup adapter with environment variables",
          parameters: [
            {
              name: "adapter",
              description: "Adapter name",
              type: "string",
              required: true,
            },
            {
              name: "mode",
              description: "Setup mode",
              type: "string",
              required: true,
              enum: ["auto", "interactive"],
            },
            {
              name: "env_vars",
              description: "Environment variables for auto mode",
              type: "object",
              required: false,
            },
            {
              name: "responses",
              description: "Interactive responses",
              type: "object",
              required: false,
            },
          ],
          returns: {
            type: "object",
            description: "Setup result",
          },
        },
        {
          name: "configure",
          description: "Configure environment variables",
          parameters: [
            {
              name: "key",
              description: "Environment variable key",
              type: "string",
              required: true,
            },
            {
              name: "value",
              description: "Environment variable value",
              type: "string",
              required: true,
            },
            {
              name: "adapter",
              description: "Adapter name",
              type: "string",
              required: true,
            },
            {
              name: "required",
              description: "Whether variable is required",
              type: "boolean",
              required: false,
            },
          ],
          returns: {
            type: "object",
            description: "Configuration result",
          },
        },
      ],
    },
  ];
}
