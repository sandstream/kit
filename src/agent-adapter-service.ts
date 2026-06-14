import { randomUUID } from "node:crypto";
import type {
  AgentProfile,
  AgentAdapter,
  AgentCapability,
  AgentIntrospection,
  AgentAutomation,
  AgentCollaboration,
  AgentMetrics,
  AgentType,
  CapabilityType,
} from "./agent-adapter-model.js";

const adapters = new Map<string, AgentAdapter>();
const capabilities = new Map<string, AgentCapability>();
const introspections = new Map<string, AgentIntrospection>();
const automations = new Map<string, AgentAutomation>();
const collaborations = new Map<string, AgentCollaboration>();

// Predefined agent profiles
const AGENT_PROFILES: Record<AgentType, AgentProfile> = {
  claude: {
    id: `profile_claude_${randomUUID()}`,
    agent_type: "claude",
    version: "4.5",
    name: "Claude AI",
    description: "Claude LLM with extended file access and debugging capabilities",
    capabilities: [
      "file_read",
      "file_write",
      "code_execution",
      "debugging",
      "testing",
      "ai_collaboration",
      "context_management",
    ],
    config_required: ["api_key"],
    optional_config: ["model", "max_tokens", "temperature"],
    installation_method: "cli",
    homepage: "https://claude.ai",
    documentation: "https://docs.anthropic.com",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  cursor: {
    id: `profile_cursor_${randomUUID()}`,
    agent_type: "cursor",
    version: "0.40",
    name: "Cursor Editor",
    description: "Cursor IDE with AI-powered code editing and workspace awareness",
    capabilities: [
      "file_read",
      "file_write",
      "code_execution",
      "git_integration",
      "debugging",
      "testing",
      "workspace_awareness",
      "ai_collaboration",
    ],
    config_required: ["editor_path", "project_root"],
    optional_config: ["git_branch", "excluded_paths"],
    installation_method: "extension",
    homepage: "https://cursor.sh",
    documentation: "https://cursor.sh/docs",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  cline: {
    id: `profile_cline_${randomUUID()}`,
    agent_type: "cline",
    version: "2.0",
    name: "Cline AI Assistant",
    description: "Cline with autonomous task execution and terminal access",
    capabilities: [
      "file_read",
      "file_write",
      "code_execution",
      "terminal_access",
      "git_integration",
      "testing",
    ],
    config_required: ["agent_key"],
    optional_config: ["allowed_commands", "max_execution_time"],
    installation_method: "cli",
    homepage: "https://cline.dev",
    documentation: "https://cline.dev/docs",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  generic: {
    id: `profile_generic_${randomUUID()}`,
    agent_type: "generic",
    version: "1.0",
    name: "Generic Agent",
    description: "Generic adapter for custom agents",
    capabilities: ["file_read", "ai_collaboration", "context_management"],
    config_required: ["agent_id"],
    optional_config: ["custom_config"],
    installation_method: "manual",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
};

/**
 * Register agent adapter for team
 */
export function registerAgentAdapter(
  team_id: string,
  agent_type: AgentType,
  config: Record<string, string | number | boolean>,
): { adapter: AgentAdapter; error?: string } {
  const profile = AGENT_PROFILES[agent_type];
  if (!profile) {
    return { adapter: {} as AgentAdapter, error: `Unknown agent type: ${agent_type}` };
  }

  // Validate required config
  const missing = profile.config_required.filter((key) => !(key in config));
  if (missing.length > 0) {
    return {
      adapter: {} as AgentAdapter,
      error: `Missing required config: ${missing.join(", ")}`,
    };
  }

  const adapter: AgentAdapter = {
    id: `adapter_${randomUUID()}`,
    team_id,
    agent_type,
    agent_profile_id: profile.id,
    status: "installed",
    version: profile.version,
    installed_at: new Date().toISOString(),
    config,
    enabled_capabilities: profile.capabilities,
    disabled_capabilities: [],
    health_status: "healthy",
    last_health_check: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  adapters.set(adapter.id, adapter);

  // Create capability records
  for (const cap of profile.capabilities) {
    const capability: AgentCapability = {
      id: `cap_${randomUUID()}`,
      adapter_id: adapter.id,
      team_id,
      capability_type: cap as CapabilityType,
      enabled: true,
      required_config: {},
      permissions_required: [],
      usage_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    capabilities.set(capability.id, capability);
  }

  return { adapter };
}

/**
 * Get agent adapter status
 */
export function getAdapterStatus(
  team_id: string,
  adapter_id: string,
): { adapter: AgentAdapter | null; error?: string } {
  const adapter = adapters.get(adapter_id);

  if (!adapter || adapter.team_id !== team_id) {
    return { adapter: null, error: "Adapter not found" };
  }

  return { adapter };
}

/**
 * Check agent capabilities
 */
export function checkCapabilities(
  team_id: string,
  adapter_id: string,
): { capabilities: AgentCapability[]; coverage_percent: number } {
  const teamCaps = Array.from(capabilities.values()).filter(
    (c) => c.adapter_id === adapter_id && c.team_id === team_id,
  );

  const enabledCount = teamCaps.filter((c) => c.enabled).length;
  const coverage = teamCaps.length > 0 ? (enabledCount / teamCaps.length) * 100 : 0;

  return { capabilities: teamCaps, coverage_percent: Math.round(coverage) };
}

/**
 * Enable/disable capability
 */
export function toggleCapability(
  team_id: string,
  capability_id: string,
  enabled: boolean,
): { capability: AgentCapability; error?: string } {
  const capability = capabilities.get(capability_id);

  if (!capability || capability.team_id !== team_id) {
    return { capability: {} as AgentCapability, error: "Capability not found" };
  }

  capability.enabled = enabled;
  capability.updated_at = new Date().toISOString();

  return { capability };
}

/**
 * Introspect agent state
 */
export function introspectAgent(
  team_id: string,
  adapter_id: string,
  introspection_type: string,
): { introspection: AgentIntrospection; error?: string } {
  const adapter = adapters.get(adapter_id);

  if (!adapter || adapter.team_id !== team_id) {
    return { introspection: {} as AgentIntrospection, error: "Adapter not found" };
  }

  const introspection: AgentIntrospection = {
    id: `intro_${randomUUID()}`,
    team_id,
    adapter_id,
    introspection_type: introspection_type as any,
    data: {
      agent_type: adapter.agent_type,
      status: adapter.status,
      health: adapter.health_status,
      capabilities_enabled: adapter.enabled_capabilities.length,
      config_keys: Object.keys(adapter.config),
    },
    timestamp: new Date().toISOString(),
    ttl_seconds: 300,
  };

  introspections.set(introspection.id, introspection);

  return { introspection };
}

/**
 * Create agent automation
 */
export function createAutomation(
  team_id: string,
  adapter_id: string,
  automation_name: string,
  trigger: string,
  actions: string[],
): { automation: AgentAutomation; error?: string } {
  const adapter = adapters.get(adapter_id);

  if (!adapter || adapter.team_id !== team_id) {
    return { automation: {} as AgentAutomation, error: "Adapter not found" };
  }

  const automation: AgentAutomation = {
    id: `auto_${randomUUID()}`,
    team_id,
    adapter_id,
    automation_name,
    trigger,
    actions,
    enabled: true,
    run_count: 0,
    error_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  automations.set(automation.id, automation);

  return { automation };
}

/**
 * Setup agent collaboration
 */
export function setupCollaboration(
  team_id: string,
  agent_adapter_ids: string[],
  collaboration_mode: string,
  shared_context?: Record<string, unknown>,
): { collaboration: AgentCollaboration; error?: string } {
  // Validate all adapters exist
  const adaptersExist = agent_adapter_ids.every((id) => {
    const a = adapters.get(id);
    return a && a.team_id === team_id;
  });

  if (!adaptersExist) {
    return { collaboration: {} as AgentCollaboration, error: "Some adapters not found" };
  }

  const collaboration: AgentCollaboration = {
    id: `collab_${randomUUID()}`,
    team_id,
    collaboration_id: `collab_${randomUUID()}`,
    agents: agent_adapter_ids.map((adapter_id, idx) => {
      const a = adapters.get(adapter_id)!;
      return {
        adapter_id,
        agent_type: a.agent_type,
        role: idx === 0 ? "primary" : idx === agent_adapter_ids.length - 1 ? "observer" : "secondary",
      };
    }),
    mode: collaboration_mode as any,
    shared_context: shared_context || {},
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  collaborations.set(collaboration.id, collaboration);

  return { collaboration };
}

/**
 * Get agent metrics
 */
export function getAdapterMetrics(team_id: string, adapter_id: string): AgentMetrics {
  const adapter = adapters.get(adapter_id) || ({} as AgentAdapter);
  const teamCaps = Array.from(capabilities.values()).filter(
    (c) => c.adapter_id === adapter_id && c.team_id === team_id,
  );
  const enabledCaps = teamCaps.filter((c) => c.enabled).length;

  const teamAutomations = Array.from(automations.values()).filter(
    (a) => a.adapter_id === adapter_id && a.team_id === team_id,
  );
  const activeAutomations = teamAutomations.filter((a) => a.enabled).length;

  const teamCollaborations = Array.from(collaborations.values()).filter(
    (c) => c.team_id === team_id && c.agents.some((a) => a.adapter_id === adapter_id),
  );
  const activeCollaborations = teamCollaborations.filter((c) => c.status === "active").length;

  return {
    adapter_id,
    agent_type: adapter.agent_type || ("generic" as AgentType),
    health_score: adapter.health_status === "healthy" ? 95 : adapter.health_status === "degraded" ? 60 : 20,
    uptime_percent: 99.5,
    capability_coverage:
      teamCaps.length > 0 ? Math.round((enabledCaps / teamCaps.length) * 100) : 0,
    average_latency_ms: 150,
    error_rate_percent: 0.5,
    last_activity: adapter.updated_at || new Date().toISOString(),
    collaborations_active: activeCollaborations,
    automations_active: activeAutomations,
    operations_today: 42,
  };
}

/**
 * List team agents
 */
export function listTeamAdapters(team_id: string): { adapters: AgentAdapter[] } {
  const teamAdapters = Array.from(adapters.values()).filter((a) => a.team_id === team_id);
  return { adapters: teamAdapters };
}

/**
 * Get collaboration status
 */
export function getCollaborationStatus(
  team_id: string,
  collaboration_id: string,
): { collaboration: AgentCollaboration | null; error?: string } {
  const collab = collaborations.get(collaboration_id);

  if (!collab || collab.team_id !== team_id) {
    return { collaboration: null, error: "Collaboration not found" };
  }

  return { collaboration: collab };
}
