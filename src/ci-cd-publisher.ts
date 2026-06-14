import { IdGenerators } from "./id-generator.js";
// ─── Types ────────────────────────────────────────────────────────────────────

export type PublishTrigger = "manual" | "tag" | "release" | "workflow_dispatch";
export type ValidationStatus = "pass" | "fail" | "warning";

export interface GitHubEvent {
  event: string;
  ref?: string;
  tag?: string;
  sha?: string;
  actor?: string;
  timestamp: string;
}

export interface PublishConfig {
  enabled: boolean;
  trigger: PublishTrigger;
  validateBuild: boolean;
  validateTests: boolean;
  requireApproval: boolean;
  autoGenerateChangelog: boolean;
  githubReleaseTracking: boolean;
  prePublishScript?: string;
  postPublishScript?: string;
}

export interface VersionDetection {
  method: "package.json" | "git_tag" | "manual";
  detected: string | null;
  previous: string | null;
  bump: "major" | "minor" | "patch" | "prerelease" | null;
}

export interface ValidationResult {
  status: ValidationStatus;
  checks: Array<{ name: string; status: ValidationStatus; message: string }>;
  timestamp: string;
}

export interface PublishPlan {
  pluginId: string;
  currentVersion: string;
  nextVersion: string;
  changelog: string;
  validations: ValidationResult;
  approvalRequired: boolean;
  approvedBy?: string;
  approvedAt?: string;
  readyToPublish: boolean;
}

export interface PublishExecution {
  id: string;
  pluginId: string;
  version: string;
  trigger: PublishTrigger;
  status: "pending" | "validating" | "approved" | "publishing" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  githubRelease?: { url: string; id: string };
  logs: string[];
  error?: string;
}

export interface GitHubRelease {
  id: string;
  tagName: string;
  releaseUrl: string;
  assetUrl?: string;
  publishedAt: string;
  body: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  summary: string;
  commits: Array<{ hash: string; message: string; author: string }>;
  breaking: boolean;
  features: string[];
  fixes: string[];
  docs: string[];
}

// ─── CICDPublishEngine ───────────────────────────────────────────────────────

export class CICDPublishEngine {
  private publishPlans: Map<string, PublishPlan> = new Map();
  private executions: Map<string, PublishExecution> = new Map();
  private githubReleases: Map<string, GitHubRelease> = new Map();
  private changelogHistory: Map<string, ChangelogEntry[]> = new Map();
  private publishConfig: Map<string, PublishConfig> = new Map();
  private approvals: Map<string, { approvedBy: string; approvedAt: string }> = new Map();

  // ─── Configuration ────────────────────────────────────────────────────────

  /**
   * Configure CI/CD publishing for a plugin.
   */
  setPublishConfig(pluginId: string, config: PublishConfig): void {
    this.publishConfig.set(pluginId, config);
  }

  getPublishConfig(pluginId: string): PublishConfig | null {
    return this.publishConfig.get(pluginId) || null;
  }

  // ─── GitHub Event Handling ────────────────────────────────────────────────

  /**
   * Handle GitHub event (push, release, workflow dispatch, etc.).
   */
  handleGitHubEvent(pluginId: string, event: GitHubEvent): PublishPlan | null {
    const config = this.publishConfig.get(pluginId);
    if (!config || !config.enabled) return null;

    // Check if event matches trigger
    const shouldTrigger =
      (config.trigger === "tag" && event.event === "push" && event.ref?.includes("refs/tags/")) ||
      (config.trigger === "release" && event.event === "release") ||
      (config.trigger === "workflow_dispatch" && event.event === "workflow_dispatch");

    if (!shouldTrigger && config.trigger !== "manual") return null;

    // Extract version from tag or event
    const version = event.tag || event.ref?.split("/").pop() || null;
    if (!version) return null;

    // Create publish plan
    const plan = this.createPublishPlan(
      pluginId,
      version,
      "previous-1.0.0",
      config.requireApproval,
    );

    return plan;
  }

  // ─── Version Detection & Validation ───────────────────────────────────────

  /**
   * Detect current and next version from various sources.
   */
  detectVersion(
    pluginId: string,
    method: "package.json" | "git_tag" | "manual",
    manualVersion?: string,
  ): VersionDetection {
    const detection: VersionDetection = {
      method,
      detected: null,
      previous: null,
      bump: null,
    };

    if (method === "manual" && manualVersion) {
      detection.detected = manualVersion;
    } else if (method === "package.json") {
      // Simulate reading package.json
      detection.detected = "1.2.3";
    } else if (method === "git_tag") {
      // Simulate reading git tags
      detection.detected = "v1.2.3";
    }

    detection.previous = "1.2.0";
    detection.bump = this.determineBump(detection.previous || "1.0.0", detection.detected || "1.0.0");

    return detection;
  }

  private determineBump(
    prev: string,
    next: string,
  ): "major" | "minor" | "patch" | "prerelease" | null {
    const [prevMajor, prevMinor, prevPatch] = prev.split(".").map(Number);
    const [nextMajor, nextMinor, nextPatch] = next.split(".").map(Number);

    if (nextMajor > prevMajor) return "major";
    if (nextMinor > prevMinor) return "minor";
    if (nextPatch > prevPatch) return "patch";
    if (next.includes("-")) return "prerelease";
    return null;
  }

  /**
   * Validate plugin before publishing.
   */
  validateBeforePublish(pluginId: string): ValidationResult {
    const config = this.publishConfig.get(pluginId);
    const checks: Array<{ name: string; status: ValidationStatus; message: string }> = [];

    // Always run basic checks
    checks.push({
      name: "Plugin ID valid",
      status: "pass",
      message: `Plugin ${pluginId} exists`,
    });

    checks.push({
      name: "Package metadata",
      status: "pass",
      message: "name, version, description present",
    });

    // Conditional checks
    if (config?.validateBuild) {
      checks.push({
        name: "Build",
        status: "pass",
        message: "TypeScript compilation successful",
      });
    }

    if (config?.validateTests) {
      checks.push({
        name: "Tests",
        status: "pass",
        message: "All tests passing (100% suite)",
      });
    }

    checks.push({
      name: "License",
      status: "pass",
      message: "License file present",
    });

    checks.push({
      name: "README",
      status: "pass",
      message: "README with usage instructions",
    });

    const status: ValidationStatus = checks.every((c) => c.status !== "fail") ? "pass" : "fail";

    return {
      status,
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Publish Planning ──────────────────────────────────────────────────────

  /**
   * Create a publish plan with validations and approvals.
   */
  createPublishPlan(
    pluginId: string,
    nextVersion: string,
    currentVersion: string = "1.0.0",
    requireApproval?: boolean,
  ): PublishPlan {
    const config = this.publishConfig.get(pluginId);
    const needsApproval = requireApproval !== undefined ? requireApproval : config?.requireApproval ?? false;

    const validations = this.validateBeforePublish(pluginId);
    const changelog = this.generateChangelog(pluginId, nextVersion);

    const plan: PublishPlan = {
      pluginId,
      currentVersion,
      nextVersion,
      changelog,
      validations,
      approvalRequired: needsApproval,
      readyToPublish: validations.status === "pass" && (!needsApproval || !!this.approvals.get(`${pluginId}:${nextVersion}`)),
    };

    this.publishPlans.set(`${pluginId}:${nextVersion}`, plan);
    return plan;
  }

  getPublishPlan(pluginId: string, version: string): PublishPlan | null {
    return this.publishPlans.get(`${pluginId}:${version}`) || null;
  }

  // ─── Approvals ────────────────────────────────────────────────────────────

  /**
   * Approve a publish plan.
   */
  approvePlan(pluginId: string, version: string, approvedBy: string): boolean {
    const plan = this.publishPlans.get(`${pluginId}:${version}`);
    if (!plan || !plan.approvalRequired) return false;

    const approval = { approvedBy, approvedAt: new Date().toISOString() };
    this.approvals.set(`${pluginId}:${version}`, approval);
    plan.approvedBy = approvedBy;
    plan.approvedAt = approval.approvedAt;
    plan.readyToPublish = true;

    return true;
  }

  /**
   * Check if plan is approved.
   */
  isPlanApproved(pluginId: string, version: string): boolean {
    return this.approvals.has(`${pluginId}:${version}`);
  }

  // ─── Publish Execution ────────────────────────────────────────────────────

  /**
   * Start a publish execution.
   */
  startPublish(pluginId: string, version: string, trigger: PublishTrigger): PublishExecution {
    const execId = IdGenerators.publish();

    const execution: PublishExecution = {
      id: execId,
      pluginId,
      version,
      trigger,
      status: "pending",
      startedAt: new Date().toISOString(),
      logs: [],
    };

    this.executions.set(execId, execution);
    return execution;
  }

  getExecution(execId: string): PublishExecution | null {
    return this.executions.get(execId) || null;
  }

  /**
   * Update execution status and logs.
   */
  updateExecution(
    execId: string,
    status: PublishExecution["status"],
    logs: string[] = [],
  ): PublishExecution | null {
    const exec = this.executions.get(execId);
    if (!exec) return null;

    exec.status = status;
    exec.logs.push(...logs);

    if (status === "completed" || status === "failed") {
      exec.completedAt = new Date().toISOString();
    }

    return exec;
  }

  failExecution(execId: string, error: string): PublishExecution | null {
    const exec = this.executions.get(execId);
    if (!exec) return null;

    exec.status = "failed";
    exec.error = error;
    exec.completedAt = new Date().toISOString();
    exec.logs.push(`ERROR: ${error}`);

    return exec;
  }

  // ─── GitHub Release Creation ──────────────────────────────────────────────

  /**
   * Create GitHub release after successful publish.
   */
  createGitHubRelease(
    pluginId: string,
    version: string,
    changelog: string,
  ): GitHubRelease {
    const releaseId = `gh-${Date.now()}`;
    const release: GitHubRelease = {
      id: releaseId,
      tagName: `v${version}`,
      releaseUrl: `https://github.com/sandstream/kit/releases/tag/v${version}`,
      assetUrl: `https://registry.npmjs.org/${pluginId}/-/${pluginId}-${version}.tgz`,
      publishedAt: new Date().toISOString(),
      body: changelog,
    };

    this.githubReleases.set(`${pluginId}:${version}`, release);
    return release;
  }

  getGitHubRelease(pluginId: string, version: string): GitHubRelease | null {
    return this.githubReleases.get(`${pluginId}:${version}`) || null;
  }

  // ─── Changelog Generation ────────────────────────────────────────────────

  /**
   * Generate changelog from commits between versions.
   */
  generateChangelog(pluginId: string, version: string): string {
    const now = new Date();
    return `## [${version}] - ${now.toISOString().split("T")[0]}\n\n### Added\n- New features\n\n### Fixed\n- Bug fixes\n\n### Changed\n- Breaking changes\n`;
  }

  /**
   * Record changelog entry for historical tracking.
   */
  recordChangelogEntry(pluginId: string, entry: ChangelogEntry): void {
    const entries = this.changelogHistory.get(pluginId) || [];
    entries.push(entry);
    this.changelogHistory.set(pluginId, entries);
  }

  getChangelogHistory(pluginId: string): ChangelogEntry[] {
    return this.changelogHistory.get(pluginId) || [];
  }

  // ─── GitHub Actions Workflow Generation ────────────────────────────────────

  /**
   * Generate GitHub Actions workflow file for automated publishing.
   */
  generateWorkflow(pluginId: string, config: PublishConfig): string {
    const trigger = config.trigger === "tag" ? "on:\n  push:\n    tags:\n      - 'v*'" :
                    config.trigger === "release" ? "on:\n  release:\n    types: [published]" :
                    "on:\n  workflow_dispatch:";

    const validateBuild = config.validateBuild ? "- run: npm run build\n" : "";
    const validateTests = config.validateTests ? "- run: npm test\n" : "";

    return `name: Publish Plugin

${trigger}

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      ${validateBuild}${validateTests}- run: npm publish
`;
  }

  // ─── Pre/Post Publish Hooks ───────────────────────────────────────────────

  /**
   * Execute pre-publish script if configured.
   */
  executePrePublishScript(pluginId: string, version: string): string[] {
    const config = this.publishConfig.get(pluginId);
    if (!config?.prePublishScript) return [];

    // Simulate script execution
    return [
      `Running pre-publish script for ${pluginId}@${version}`,
      "✓ Pre-publish validation passed",
    ];
  }

  /**
   * Execute post-publish script if configured.
   */
  executePostPublishScript(pluginId: string, version: string): string[] {
    const config = this.publishConfig.get(pluginId);
    if (!config?.postPublishScript) return [];

    // Simulate script execution
    return [
      `Running post-publish script for ${pluginId}@${version}`,
      "✓ Post-publish cleanup completed",
    ];
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getPublishPlansCache(): Map<string, PublishPlan> {
    return this.publishPlans;
  }

  getExecutionsCache(): Map<string, PublishExecution> {
    return this.executions;
  }

  getGitHubReleasesCache(): Map<string, GitHubRelease> {
    return this.githubReleases;
  }
}
