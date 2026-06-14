import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  CICDPublishEngine,
  type PublishConfig,
  type GitHubEvent,
} from "./ci-cd-publisher.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PublishConfig> = {}): PublishConfig {
  return {
    enabled: true,
    trigger: "tag",
    validateBuild: true,
    validateTests: true,
    requireApproval: false,
    autoGenerateChangelog: true,
    githubReleaseTracking: true,
    ...overrides,
  };
}

function makeGitHubEvent(
  event: string,
  overrides: Partial<GitHubEvent> = {},
): GitHubEvent {
  return {
    event,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CICDPublishEngine", () => {
  describe("initialization", () => {
    it("creates engine instance", () => {
      const engine = new CICDPublishEngine();
      assert(engine);
    });

    it("starts with empty caches", () => {
      const engine = new CICDPublishEngine();
      assert.equal(engine.getPublishPlansCache().size, 0);
      assert.equal(engine.getExecutionsCache().size, 0);
      assert.equal(engine.getGitHubReleasesCache().size, 0);
    });
  });

  describe("setPublishConfig & getPublishConfig", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
    });

    it("stores publish config", () => {
      const config = makeConfig();
      engine.setPublishConfig("stripe/payments", config);
      const stored = engine.getPublishConfig("stripe/payments");
      assert.deepEqual(stored, config);
    });

    it("returns null for unknown plugin", () => {
      const config = engine.getPublishConfig("unknown");
      assert.equal(config, null);
    });

    it("supports multiple plugins", () => {
      engine.setPublishConfig("stripe/payments", makeConfig());
      engine.setPublishConfig("supabase/db", makeConfig({ trigger: "release" }));

      const stripe = engine.getPublishConfig("stripe/payments");
      const supabase = engine.getPublishConfig("supabase/db");
      assert(stripe);
      assert(supabase);
      assert.notEqual(stripe.trigger, supabase.trigger);
    });
  });

  describe("handleGitHubEvent", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
      engine.setPublishConfig("stripe/payments", makeConfig({ trigger: "tag" }));
      engine.setPublishConfig("supabase/db", makeConfig({ trigger: "release" }));
    });

    it("creates publish plan on tag push", () => {
      const plan = engine.handleGitHubEvent(
        "stripe/payments",
        makeGitHubEvent("push", { ref: "refs/tags/v1.2.3", tag: "v1.2.3" }),
      );
      assert(plan);
      assert.equal(plan.nextVersion, "v1.2.3");
    });

    it("creates publish plan on release event", () => {
      const plan = engine.handleGitHubEvent(
        "supabase/db",
        makeGitHubEvent("release", { tag: "v2.0.0" }),
      );
      assert(plan);
    });

    it("returns null if config disabled", () => {
      engine.setPublishConfig("disabled", makeConfig({ enabled: false }));
      const plan = engine.handleGitHubEvent(
        "disabled",
        makeGitHubEvent("push", { tag: "v1.0.0" }),
      );
      assert.equal(plan, null);
    });

    it("returns null if trigger doesn't match", () => {
      const plan = engine.handleGitHubEvent(
        "stripe/payments",
        makeGitHubEvent("release", { tag: "v1.0.0" }),
      );
      assert.equal(plan, null);
    });

    it("returns null if no version in event", () => {
      const plan = engine.handleGitHubEvent(
        "stripe/payments",
        makeGitHubEvent("push", { ref: "refs/heads/main" }),
      );
      assert.equal(plan, null);
    });
  });

  describe("detectVersion", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
    });

    it("detects version from package.json method", () => {
      const detection = engine.detectVersion("stripe/payments", "package.json");
      assert.equal(detection.method, "package.json");
      assert(detection.detected);
    });

    it("detects version from git tag method", () => {
      const detection = engine.detectVersion("stripe/payments", "git_tag");
      assert.equal(detection.method, "git_tag");
      assert(detection.detected);
    });

    it("accepts manual version", () => {
      const detection = engine.detectVersion("stripe/payments", "manual", "1.5.0");
      assert.equal(detection.detected, "1.5.0");
    });

    it("determines bump type", () => {
      const detection = engine.detectVersion("stripe/payments", "manual", "2.0.0");
      assert(detection.bump); // Should detect some bump type
    });
  });

  describe("validateBeforePublish", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
      engine.setPublishConfig("test-plugin", makeConfig());
    });

    it("returns validation result", () => {
      const result = engine.validateBeforePublish("test-plugin");
      assert(result.checks.length > 0);
      assert(result.status);
      assert(result.timestamp);
    });

    it("includes build check when configured", () => {
      engine.setPublishConfig("test-plugin", makeConfig({ validateBuild: true }));
      const result = engine.validateBeforePublish("test-plugin");
      assert(result.checks.some((c) => c.name === "Build"));
    });

    it("includes test check when configured", () => {
      engine.setPublishConfig("test-plugin", makeConfig({ validateTests: true }));
      const result = engine.validateBeforePublish("test-plugin");
      assert(result.checks.some((c) => c.name === "Tests"));
    });

    it("marks validation as pass when all checks pass", () => {
      const result = engine.validateBeforePublish("test-plugin");
      assert.equal(result.status, "pass");
    });
  });

  describe("createPublishPlan", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
      engine.setPublishConfig("stripe/payments", makeConfig());
    });

    it("creates publish plan", () => {
      const plan = engine.createPublishPlan("stripe/payments", "1.2.3", "1.2.0");
      assert(plan);
      assert.equal(plan.nextVersion, "1.2.3");
      assert.equal(plan.currentVersion, "1.2.0");
    });

    it("includes validation results", () => {
      const plan = engine.createPublishPlan("stripe/payments", "1.2.3");
      assert(plan.validations);
      assert(plan.validations.checks.length > 0);
    });

    it("includes changelog", () => {
      const plan = engine.createPublishPlan("stripe/payments", "1.2.3");
      assert(plan.changelog);
      assert(plan.changelog.includes("1.2.3"));
    });

    it("marks as ready when no approval required", () => {
      engine.setPublishConfig("stripe/payments", makeConfig({ requireApproval: false }));
      const plan = engine.createPublishPlan("stripe/payments", "1.2.3");
      assert(plan.readyToPublish);
    });

    it("marks as not ready when approval required", () => {
      engine.setPublishConfig("stripe/payments", makeConfig({ requireApproval: true }));
      const plan = engine.createPublishPlan("stripe/payments", "1.2.3");
      assert(!plan.readyToPublish);
    });

    it("retrieves plan by pluginId and version", () => {
      const created = engine.createPublishPlan("stripe/payments", "1.2.3");
      const retrieved = engine.getPublishPlan("stripe/payments", "1.2.3");
      assert.equal(retrieved?.nextVersion, created.nextVersion);
    });
  });

  describe("approvePlan & isPlanApproved", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
      engine.setPublishConfig("stripe/payments", makeConfig({ requireApproval: true }));
      engine.createPublishPlan("stripe/payments", "1.2.3");
    });

    it("approves a plan", () => {
      const approved = engine.approvePlan("stripe/payments", "1.2.3", "user-1");
      assert(approved);
    });

    it("returns false when no plan exists", () => {
      const approved = engine.approvePlan("unknown", "1.0.0", "user-1");
      assert(!approved);
    });

    it("checks if plan is approved", () => {
      engine.approvePlan("stripe/payments", "1.2.3", "user-1");
      assert(engine.isPlanApproved("stripe/payments", "1.2.3"));
    });

    it("marks plan as ready after approval", () => {
      engine.approvePlan("stripe/payments", "1.2.3", "user-1");
      const plan = engine.getPublishPlan("stripe/payments", "1.2.3");
      assert(plan?.readyToPublish);
      assert.equal(plan?.approvedBy, "user-1");
    });
  });

  describe("startPublish & updateExecution", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
    });

    it("starts a publish execution", () => {
      const exec = engine.startPublish("stripe/payments", "1.2.3", "tag");
      assert(exec.id);
      assert.equal(exec.status, "pending");
      assert.equal(exec.version, "1.2.3");
    });

    it("retrieves execution by ID", () => {
      const started = engine.startPublish("stripe/payments", "1.2.3", "tag");
      const retrieved = engine.getExecution(started.id);
      assert.equal(retrieved?.id, started.id);
    });

    it("returns null for unknown execution", () => {
      const exec = engine.getExecution("unknown");
      assert.equal(exec, null);
    });

    it("updates execution status", () => {
      const started = engine.startPublish("stripe/payments", "1.2.3", "tag");
      const updated = engine.updateExecution(started.id, "validating", ["Running tests"]);
      assert.equal(updated?.status, "validating");
      assert(updated?.logs.includes("Running tests"));
    });

    it("appends logs on update", () => {
      const started = engine.startPublish("stripe/payments", "1.2.3", "tag");
      engine.updateExecution(started.id, "validating", ["Log 1"]);
      engine.updateExecution(started.id, "publishing", ["Log 2"]);
      const final = engine.getExecution(started.id);
      assert.equal(final?.logs.length, 2);
    });

    it("marks completion time when done", () => {
      const started = engine.startPublish("stripe/payments", "1.2.3", "tag");
      engine.updateExecution(started.id, "completed");
      const final = engine.getExecution(started.id);
      assert(final?.completedAt);
    });

    it("failExecution sets error and failed status", () => {
      const started = engine.startPublish("stripe/payments", "1.2.3", "tag");
      engine.failExecution(started.id, "Build failed");
      const final = engine.getExecution(started.id);
      assert.equal(final?.status, "failed");
      assert.equal(final?.error, "Build failed");
      assert(final?.completedAt);
    });
  });

  describe("createGitHubRelease", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
    });

    it("creates GitHub release", () => {
      const release = engine.createGitHubRelease(
        "stripe/payments",
        "1.2.3",
        "## Changes\n- Feature X",
      );
      assert(release.id);
      assert.equal(release.tagName, "v1.2.3");
      assert(release.releaseUrl.includes("v1.2.3"));
    });

    it("includes asset URL for npm", () => {
      const release = engine.createGitHubRelease("stripe/payments", "1.2.3", "");
      assert(release.assetUrl);
      assert(release.assetUrl.includes("stripe/payments"));
      assert(release.assetUrl.includes("1.2.3"));
    });

    it("retrieves release by plugin and version", () => {
      const created = engine.createGitHubRelease("stripe/payments", "1.2.3", "");
      const retrieved = engine.getGitHubRelease("stripe/payments", "1.2.3");
      assert.equal(retrieved?.id, created.id);
    });

    it("returns null for unknown release", () => {
      const release = engine.getGitHubRelease("unknown", "1.0.0");
      assert.equal(release, null);
    });
  });

  describe("generateChangelog", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
    });

    it("generates changelog", () => {
      const changelog = engine.generateChangelog("stripe/payments", "1.2.3");
      assert(changelog.includes("1.2.3"));
      assert(changelog.includes("Added"));
      assert(changelog.includes("Fixed"));
    });

    it("includes version and date", () => {
      const changelog = engine.generateChangelog("stripe/payments", "2.0.0");
      assert(changelog.includes("[2.0.0]"));
    });
  });

  describe("generateWorkflow", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
    });

    it("generates GitHub Actions workflow for tag trigger", () => {
      const config = makeConfig({ trigger: "tag" });
      const workflow = engine.generateWorkflow("stripe/payments", config);
      assert(workflow.includes("on:"));
      assert(workflow.includes("push:"));
      assert(workflow.includes("tags:"));
    });

    it("includes build step when configured", () => {
      const config = makeConfig({ trigger: "tag", validateBuild: true });
      const workflow = engine.generateWorkflow("stripe/payments", config);
      assert(workflow.includes("npm run build"));
    });

    it("includes test step when configured", () => {
      const config = makeConfig({ trigger: "tag", validateTests: true });
      const workflow = engine.generateWorkflow("stripe/payments", config);
      assert(workflow.includes("npm test"));
    });

    it("generates workflow for release trigger", () => {
      const config = makeConfig({ trigger: "release" });
      const workflow = engine.generateWorkflow("stripe/payments", config);
      assert(workflow.includes("release:"));
    });
  });

  describe("pre/post publish scripts", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
    });

    it("executes pre-publish script when configured", () => {
      const config = makeConfig({ prePublishScript: "npm run validate" });
      engine.setPublishConfig("stripe/payments", config);
      const logs = engine.executePrePublishScript("stripe/payments", "1.2.3");
      assert(logs.length > 0);
      assert(logs.some((l) => l.includes("validation")));
    });

    it("executes post-publish script when configured", () => {
      const config = makeConfig({ postPublishScript: "npm run cleanup" });
      engine.setPublishConfig("stripe/payments", config);
      const logs = engine.executePostPublishScript("stripe/payments", "1.2.3");
      assert(logs.length > 0);
      assert(logs.some((l) => l.includes("cleanup")));
    });

    it("returns empty logs when no script configured", () => {
      const logs = engine.executePrePublishScript("stripe/payments", "1.2.3");
      assert.equal(logs.length, 0);
    });
  });

  describe("changelog history", () => {
    let engine: CICDPublishEngine;

    beforeEach(() => {
      engine = new CICDPublishEngine();
    });

    it("records changelog entry", () => {
      engine.recordChangelogEntry("stripe/payments", {
        version: "1.0.0",
        date: "2025-04-15",
        summary: "Initial release",
        commits: [],
        breaking: false,
        features: ["Feature A"],
        fixes: [],
        docs: [],
      });
      const history = engine.getChangelogHistory("stripe/payments");
      assert.equal(history.length, 1);
    });

    it("tracks multiple changelog entries", () => {
      engine.recordChangelogEntry("stripe/payments", {
        version: "1.0.0",
        date: "2025-04-15",
        summary: "Initial release",
        commits: [],
        breaking: false,
        features: [],
        fixes: [],
        docs: [],
      });
      engine.recordChangelogEntry("stripe/payments", {
        version: "1.1.0",
        date: "2025-04-16",
        summary: "Bug fixes",
        commits: [],
        breaking: false,
        features: [],
        fixes: ["Bug X"],
        docs: [],
      });
      const history = engine.getChangelogHistory("stripe/payments");
      assert.equal(history.length, 2);
    });
  });
});
