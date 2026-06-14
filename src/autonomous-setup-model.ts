/**
 * Autonomous Project Setup — data models
 * Agents initialize projects with minimal guidance via workflow orchestration
 */

export type SetupPhase = "detection" | "planning" | "initialization" | "verification" | "complete";
export type ProjectType = "nodejs" | "python" | "go" | "rust" | "java" | "custom";
export type SetupStatus = "pending" | "in_progress" | "completed" | "failed" | "paused";
export type DecisionMode = "autonomous" | "guided" | "manual";

export interface ProjectDetection {
  id: string;
  project_path: string;
  detected_type: ProjectType;
  confidence: number; // 0-100
  detected_tools: string[];
  detected_frameworks: string[];
  detected_services: string[];
  language_primary?: string;
  package_manager?: string;
  git_initialized: boolean;
  detected_at: string;
}

export interface SetupWorkflow {
  id: string;
  team_id: string;
  project_id: string;
  project_path: string;
  project_type: ProjectType;
  workflow_name: string;
  current_phase: SetupPhase;
  phases_completed: SetupPhase[];
  decision_mode: DecisionMode;
  steps: SetupStep[];
  status: SetupStatus;
  initiated_by: string;
  initiated_at: string;
  estimated_completion?: string;
  actual_completion?: string;
  created_at: string;
  updated_at: string;
}

export interface SetupStep {
  id: string;
  workflow_id: string;
  step_number: number;
  step_name: string;
  description: string;
  category: "detect" | "install" | "configure" | "initialize" | "test" | "verify";
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  command?: string;
  expected_output?: string;
  error_message?: string;
  executed_at?: string;
  duration_ms?: number;
  requires_approval: boolean;
  approved_by?: string;
  approved_at?: string;
  rollback_command?: string;
  created_at: string;
  updated_at: string;
}

export interface SetupDecision {
  id: string;
  workflow_id: string;
  step_id: string;
  team_id: string;
  decision_type: "tool_selection" | "configuration" | "service" | "dependency" | "other";
  question: string;
  options: string[];
  recommendation?: string;
  selected_option?: string;
  selected_by?: string;
  selected_at?: string;
  reasoning?: string;
  created_at: string;
}

export interface SetupPreset {
  id: string;
  preset_name: string;
  project_type: ProjectType;
  description?: string;
  tools: string[];
  services: string[];
  framework?: string;
  database?: string;
  auth_method?: string;
  hosting?: string;
  ci_cd?: string;
  monitoring?: string;
  created_at: string;
  public: boolean;
}

export interface SetupVerification {
  id: string;
  workflow_id: string;
  team_id: string;
  verification_type: "tools" | "services" | "secrets" | "config" | "health";
  status: "passed" | "failed" | "warning";
  checks: {
    name: string;
    status: "pass" | "fail" | "warn";
    message?: string;
  }[];
  verified_at: string;
}

export interface SetupMetrics {
  total_workflows: number;
  completed_workflows: number;
  failed_workflows: number;
  in_progress: number;
  average_duration_minutes: number;
  success_rate_percent: number;
  most_common_project_type: ProjectType;
  most_common_preset: string;
  autonomous_success_rate: number;
  guided_success_rate: number;
  manual_success_rate: number;
}
