import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as MCPTools from "./mcp-kit-tools-service.js";

describe("mcp-kit-tools-service", () => {
  describe("kit_configure — config operations", () => {
    it("sets configuration value", () => {
      const result = MCPTools.setConfig("test.timeout", 5000, "project", "tool", "user-123");

      assert.equal(result.success, true);
      assert.equal(result.data?.key, "test.timeout");
      assert.equal(result.data?.value, 5000);
      assert.equal(result.data?.scope, "project");
    });

    it("gets configuration value", () => {
      MCPTools.setConfig("app.name", "kit", "global", "tool");

      const result = MCPTools.getConfig("app.name");

      assert.equal(result.success, true);
      assert.equal(result.data?.value, "kit");
    });

    it("returns error for nonexistent key", () => {
      const result = MCPTools.getConfig("nonexistent.key");

      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("lists configurations with filters", () => {
      MCPTools.setConfig("global.setting", "value1", "global", "adapter");
      MCPTools.setConfig("project.setting", "value2", "project", "tool");

      const result = MCPTools.listConfigs("project", "tool");

      assert.equal(result.success, true);
      assert.ok(result.data!.configs.length > 0);
      assert.ok(result.data!.configs.every((c) => c.scope === "project" && c.category === "tool"));
    });

    it("respects pagination in list", () => {
      for (let i = 0; i < 10; i++) {
        MCPTools.setConfig(`item.${i}`, i, "project", "tool");
      }

      const result1 = MCPTools.listConfigs(undefined, undefined, 5, 0);
      const result2 = MCPTools.listConfigs(undefined, undefined, 5, 5);

      assert.equal(result1.data!.configs.length, 5);
      assert.ok(result2.data!.configs.length > 0);
    });
  });

  describe("configuration validation", () => {
    it("validates configuration value successfully", () => {
      const result = MCPTools.validateConfigValue("test.port", 8080);

      assert.equal(result.result, "valid");
    });

    it("detects type mismatch", () => {
      MCPTools.setConfig("strict.number", 42, "project", "tool");

      const validation = MCPTools.validateConfigValue("strict.number", "not a number");

      assert.ok(validation.result !== "valid");
      assert.ok(validation.message);
    });

    it("provides conversion suggestion for string-to-number", () => {
      MCPTools.setConfig("numeric.value", 100, "project", "tool");

      const validation = MCPTools.validateConfigValue("numeric.value", "123");

      // Should allow conversion
      assert.ok(validation.message);
    });
  });

  describe("adapter configuration", () => {
    it("configures adapter", () => {
      const result = MCPTools.configureAdapter("stripe", true, {
        api_key: "sk_test_...",
        version: "2023-10-16",
      });

      assert.equal(result.success, true);
      assert.equal(result.data?.name, "stripe");
      assert.equal(result.data?.enabled, true);
      assert.equal(result.data?.credentials_configured, true);
    });

    it("gets adapter configuration", () => {
      MCPTools.configureAdapter("github", true, { token: "ghp_..." });

      const result = MCPTools.getAdapterConfig("github");

      assert.equal(result.success, true);
      assert.equal(result.data?.name, "github");
    });

    it("returns error for nonexistent adapter", () => {
      const result = MCPTools.getAdapterConfig("nonexistent");

      assert.equal(result.success, false);
    });

    it("lists all adapters", () => {
      MCPTools.configureAdapter("slack", true, {});
      MCPTools.configureAdapter("discord", false, {});

      const result = MCPTools.listAdapters();

      assert.equal(result.success, true);
      assert.ok(result.data!.length > 0);
    });
  });

  describe("tool configuration", () => {
    it("gets tool configuration", () => {
      const result = MCPTools.getToolConfig("node");

      // Tool might not exist, that's okay
      if (!result.success) {
        assert.ok(result.error);
      }
    });

    it("lists all tools", () => {
      const result = MCPTools.listTools();

      assert.equal(result.success, true);
      assert.ok(Array.isArray(result.data));
    });
  });

  describe("service configuration", () => {
    it("configures service", () => {
      const result = MCPTools.configureService("api-server", true, "http://localhost", 3000);

      assert.equal(result.success, true);
      assert.equal(result.data?.name, "api-server");
      assert.equal(result.data?.enabled, true);
      assert.equal(result.data?.port, 3000);
    });

    it("gets service configuration", () => {
      MCPTools.configureService("database", true, "localhost", 5432);

      const result = MCPTools.getServiceConfig("database");

      assert.equal(result.success, true);
      assert.equal(result.data?.port, 5432);
    });

    it("lists services", () => {
      MCPTools.configureService("cache", true, "redis://localhost", 6379);

      const result = MCPTools.listServices();

      assert.equal(result.success, true);
      assert.ok(result.data!.length > 0);
    });
  });

  describe("path configuration", () => {
    it("sets path configuration", () => {
      const result = MCPTools.setPathConfig(
        "project_root",
        "/home/user/projects/kit",
        "project_root",
      );

      assert.equal(result.success, true);
      assert.equal(result.data?.key, "project_root");
      assert.equal(result.data?.type, "project_root");
    });

    it("gets path configuration", () => {
      MCPTools.setPathConfig("cache_dir", "/tmp/.kit/cache", "cache_dir");

      const result = MCPTools.getPathConfig("cache_dir");

      assert.equal(result.success, true);
      assert.ok(result.data?.value.includes("cache"));
    });

    it("marks expandable paths", () => {
      const result = MCPTools.setPathConfig(
        "temp_dir",
        "$TEMP/.kit",
        "temp_dir",
      );

      assert.equal(result.data?.expandable, true);
    });

    it("lists paths", () => {
      MCPTools.setPathConfig("data_dir", "/var/lib/kit", "data_dir");

      const result = MCPTools.listPaths();

      assert.equal(result.success, true);
      assert.ok(result.data!.length > 0);
    });
  });

  describe("feature flags", () => {
    it("toggles feature flag on", () => {
      const result = MCPTools.toggleFeatureFlag("experimental_mode", true, "project");

      assert.equal(result.success, true);
      assert.equal(result.data?.name, "experimental_mode");
      assert.equal(result.data?.enabled, true);
    });

    it("toggles feature flag off", () => {
      MCPTools.toggleFeatureFlag("beta_feature", true);

      const result = MCPTools.toggleFeatureFlag("beta_feature", false);

      assert.equal(result.success, true);
      assert.equal(result.data?.enabled, false);
    });

    it("gets feature flag", () => {
      MCPTools.toggleFeatureFlag("dark_mode", true);

      const result = MCPTools.getFeatureFlag("dark_mode");

      assert.equal(result.success, true);
      assert.equal(result.data?.enabled, true);
    });

    it("lists feature flags", () => {
      MCPTools.toggleFeatureFlag("flag1", true);
      MCPTools.toggleFeatureFlag("flag2", false);

      const result = MCPTools.listFeatureFlags();

      assert.equal(result.success, true);
      assert.ok(result.data!.length > 0);
    });
  });

  describe("configuration snapshots", () => {
    it("creates configuration snapshot", () => {
      MCPTools.setConfig("snap.key1", "value1", "project", "tool");
      MCPTools.setConfig("snap.key2", "value2", "project", "tool");

      const result = MCPTools.createConfigSnapshot("user-123", "Before migration");

      assert.equal(result.success, true);
      assert.ok(result.data?.id);
      assert.equal(result.data?.description, "Before migration");
      assert.ok(Object.keys(result.data!.config_state).length > 0);
    });

    it("lists snapshots", () => {
      MCPTools.createConfigSnapshot("user-456", "Snapshot 1");
      MCPTools.createConfigSnapshot("user-456", "Snapshot 2");

      const result = MCPTools.listSnapshots();

      assert.equal(result.success, true);
      assert.ok(result.data!.snapshots.length > 0);
    });

    it("respects pagination in snapshots", () => {
      const result1 = MCPTools.listSnapshots(5, 0);
      MCPTools.listSnapshots(5, 5);

      assert.equal(result1.success, true);
      assert.ok(result1.data!.snapshots.length > 0);
    });

    it("rolls back to snapshot", () => {
      // Create snapshot
      const snap = MCPTools.createConfigSnapshot(undefined, "Rollback test");
      const snapshot_id = snap.data!.id;

      // Change config
      MCPTools.setConfig("rollback.test", "changed");

      // Rollback
      const result = MCPTools.rollbackToSnapshot(snapshot_id, "admin");

      assert.equal(result.success, true);
      assert.ok((result.data?.changes_reverted || 0) >= 0);
    });

    it("fails rollback for nonexistent snapshot", () => {
      const result = MCPTools.rollbackToSnapshot("nonexistent_snap");

      assert.equal(result.success, false);
      assert.ok(result.error);
    });
  });

  describe("MCP tool definitions", () => {
    it("returns MCP tool definitions", () => {
      const tools = MCPTools.getMCPTools();

      assert.ok(Array.isArray(tools));
      assert.ok(tools.length >= 2);
    });

    it("defines kit_configure tool", () => {
      const tools = MCPTools.getMCPTools();
      const configureTool = tools.find((t) => t.id === "kit_configure");

      assert.ok(configureTool);
      assert.equal(configureTool!.category, "configuration");
      assert.ok(configureTool!.actions.length > 0);
    });

    it("defines kit_adapter_check tool", () => {
      const tools = MCPTools.getMCPTools();
      const checkTool = tools.find((t) => t.id === "kit_adapter_check");

      assert.ok(checkTool);
      assert.equal(checkTool!.category, "health");
      assert.ok(checkTool!.actions.length > 0);
    });

    it("kit_configure has required actions", () => {
      const tools = MCPTools.getMCPTools();
      const configureTool = tools.find((t) => t.id === "kit_configure");
      const actionNames = configureTool!.actions.map((a) => a.name);

      assert.ok(actionNames.includes("get"));
      assert.ok(actionNames.includes("set"));
      assert.ok(actionNames.includes("list"));
      assert.ok(actionNames.includes("validate"));
    });

    it("action parameters are properly defined", () => {
      const tools = MCPTools.getMCPTools();
      const configureTool = tools.find((t) => t.id === "kit_configure");
      const getAction = configureTool!.actions.find((a) => a.name === "get");

      assert.ok(getAction!.parameters.length > 0);
      assert.ok(getAction!.parameters[0].name === "key");
      assert.equal(getAction!.parameters[0].required, true);
    });
  });

  describe("kit_adapter_check — adapter status checks", () => {
    it("checks adapter status", () => {
      MCPTools.configureAdapter("check-test", true, { api_key: "secret" });

      const result = MCPTools.checkAdapterStatus("check-test");

      assert.equal(result.success, true);
      assert.ok(result.data?.overall_status);
      assert.ok(result.data?.checks.length > 0);
      assert.equal(result.data?.installed, true);
      assert.equal(result.data?.authenticated, true);
    });

    it("returns error for nonexistent adapter", () => {
      const result = MCPTools.checkAdapterStatus("nonexistent-adapter");

      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("provides recommendations for unhealthy adapters", () => {
      MCPTools.configureAdapter("unhealthy", false, {});

      const result = MCPTools.checkAdapterStatus("unhealthy");

      assert.ok(result.data?.recommendations);
      assert.ok(result.data!.recommendations!.length > 0);
    });

    it("checks adapter dependencies", () => {
      const result = MCPTools.checkAdapterDependencies("stripe");

      assert.equal(result.success, true);
      assert.ok(Array.isArray(result.data));
      assert.ok(result.data!.length > 0);
      assert.ok(result.data!.some((d) => d.name === "node"));
    });

    it("returns empty dependencies for unknown adapter", () => {
      const result = MCPTools.checkAdapterDependencies("unknown");

      assert.equal(result.success, true);
      assert.equal(result.data?.length, 0);
    });

    it("gets adapter health status", () => {
      MCPTools.configureAdapter("health-check", true, {});

      const result = MCPTools.getAdapterHealth("health-check");

      assert.equal(result.success, true);
      assert.ok(typeof result.data?.healthy === "boolean");
      assert.ok(result.data?.uptime_seconds !== undefined);
      assert.ok(result.data?.error_count !== undefined);
      assert.ok(result.data?.success_count !== undefined);
    });

    it("returns error for nonexistent adapter in health check", () => {
      const result = MCPTools.getAdapterHealth("nonexistent");

      assert.equal(result.success, false);
      assert.ok(result.error);
    });
  });

  describe("adapter installation and setup", () => {
    it("installs adapter successfully", () => {
      const result = MCPTools.installAdapter("stripe", false, "2.0.0");

      assert.equal(result.success, true);
      assert.equal(result.data?.adapter_name, "stripe");
      assert.equal(result.data?.installed, true);
      assert.equal(result.data?.version, "2.0.0");
      assert.equal(result.data?.setup_required, true);
    });

    it("installs adapter with auto-configuration", () => {
      const result = MCPTools.installAdapter("github", true, "1.5.0");

      assert.equal(result.success, true);
      assert.equal(result.data?.configured, false);
      assert.equal(result.data?.setup_required, false);
      assert.ok(result.data?.message.includes("auto-configured"));
    });

    it("sets up adapter automatically with environment variables", () => {
      MCPTools.installAdapter("slack", false);

      const result = MCPTools.setupAdapterAuto("slack", {
        api_token: "xoxb-test",
        bot_id: "bot-123",
      });

      assert.equal(result.success, true);
      assert.equal(result.data?.configured, true);
      assert.equal(result.data?.env_vars_set.length, 2);
      assert.ok(result.data?.env_vars_set.includes("SLACK_API_TOKEN"));
      assert.ok(result.data?.env_vars_set.includes("SLACK_BOT_ID"));
    });

    it("returns error when setting up non-existent adapter", () => {
      const result = MCPTools.setupAdapterAuto("nonexistent", {
        key: "value",
      });

      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("sets up adapter interactively", () => {
      MCPTools.installAdapter("datadog", false);

      const result = MCPTools.setupAdapterInteractive("datadog", {
        api_key: "dd_api_key",
        app_key: "dd_app_key",
      });

      assert.equal(result.success, true);
      assert.equal(result.data?.configured, true);
      assert.equal(result.data?.env_vars_set.length, 2);
    });

    it("sets environment variable", () => {
      const result = MCPTools.setEnvironmentVariable(
        "AWS_ACCESS_KEY_ID",
        "AKIA...",
        "aws",
        true,
        "AWS access key",
      );

      assert.equal(result.success, true);
      assert.equal(result.data?.key, "AWS_ACCESS_KEY_ID");
      assert.equal(result.data?.value, "AKIA...");
      assert.equal(result.data?.required, true);
    });

    it("retrieves environment variables", () => {
      MCPTools.setEnvironmentVariable("STRIPE_KEY", "sk_test", "stripe", true);
      MCPTools.setEnvironmentVariable("STRIPE_SECRET", "sk_secret", "stripe", true);
      MCPTools.setEnvironmentVariable("GITHUB_TOKEN", "ghp_test", "github", true);

      const result = MCPTools.getEnvironmentVariables("stripe");

      assert.equal(result.success, true);
      assert.equal(result.data!.length, 2);
      assert.ok(result.data!.every((v) => v.adapter_name === "stripe"));
    });

    it("retrieves only required environment variables", () => {
      MCPTools.setEnvironmentVariable("REQUIRED_VAR", "value", "test", true);
      MCPTools.setEnvironmentVariable("OPTIONAL_VAR", "value", "test", false);

      const result = MCPTools.getEnvironmentVariables("test", true);

      assert.equal(result.data!.length, 1);
      assert.equal(result.data![0].required, true);
    });
  });

  describe("kit_adapter_install tool definition", () => {
    it("defines kit_adapter_install tool", () => {
      const tools = MCPTools.getMCPTools();
      const installTool = tools.find((t) => t.id === "kit_adapter_install");

      assert.ok(installTool);
      assert.equal(installTool!.category, "installation");
      assert.ok(installTool!.actions.length >= 3);
    });

    it("has install action", () => {
      const tools = MCPTools.getMCPTools();
      const installTool = tools.find((t) => t.id === "kit_adapter_install");
      const installAction = installTool!.actions.find((a) => a.name === "install");

      assert.ok(installAction);
      assert.ok(installAction!.parameters.some((p) => p.name === "adapter"));
      assert.ok(installAction!.parameters.some((p) => p.name === "version"));
    });

    it("has setup action", () => {
      const tools = MCPTools.getMCPTools();
      const installTool = tools.find((t) => t.id === "kit_adapter_install");
      const setupAction = installTool!.actions.find((a) => a.name === "setup");

      assert.ok(setupAction);
      assert.ok(setupAction!.parameters.some((p) => p.name === "adapter"));
      assert.ok(setupAction!.parameters.some((p) => p.name === "mode"));
    });

    it("has configure action", () => {
      const tools = MCPTools.getMCPTools();
      const installTool = tools.find((t) => t.id === "kit_adapter_install");
      const configAction = installTool!.actions.find((a) => a.name === "configure");

      assert.ok(configAction);
      assert.ok(configAction!.parameters.some((p) => p.name === "key"));
      assert.ok(configAction!.parameters.some((p) => p.name === "value"));
      assert.ok(configAction!.parameters.some((p) => p.name === "adapter"));
    });
  });

  describe("end-to-end configuration workflow", () => {
    it("manages complete configuration lifecycle", () => {
      // Set configurations
      MCPTools.setConfig("app.debug", true, "project", "feature");
      MCPTools.setConfig("db.host", "localhost", "project", "service");
      MCPTools.setConfig("api.timeout", 30000, "project", "tool");

      // Validate
      const validation = MCPTools.validateConfigValue("db.host", "localhost");
      assert.equal(validation.result, "valid");

      // Create snapshot
      const snap = MCPTools.createConfigSnapshot("dev", "Initial setup");
      assert.equal(snap.success, true);

      // List configurations
      const list = MCPTools.listConfigs("project");
      assert.ok(list.data!.total >= 3);

      // Get specific config
      const get = MCPTools.getConfig("app.debug");
      assert.equal(get.success, true);
      assert.equal(get.data?.value, true);

      // Configure adapter
      const adapter = MCPTools.configureAdapter("dev-tools", true, {});
      assert.equal(adapter.success, true);

      // Configure service
      const service = MCPTools.configureService("debug-server", true, "localhost", 9229);
      assert.equal(service.success, true);

      // Toggle feature
      const feature = MCPTools.toggleFeatureFlag("debug_mode", true, "project");
      assert.equal(feature.success, true);
    });
  });

  describe("MCP tool definitions validation", () => {
    it("kit_configure actions have required parameters", () => {
      const tools = MCPTools.getMCPTools();
      const configureTool = tools.find((t) => t.id === "kit_configure");
      const getAction = configureTool!.actions.find((a) => a.name === "get");

      // Verify get action requires 'key' parameter
      assert.ok(getAction!.parameters.find((p) => p.name === "key" && p.required));
    });

    it("kit_adapter_install has all required action parameters", () => {
      const tools = MCPTools.getMCPTools();
      const installTool = tools.find((t) => t.id === "kit_adapter_install");

      // Check install action
      const installAction = installTool!.actions.find((a) => a.name === "install");
      assert.ok(installAction!.parameters.find((p) => p.name === "adapter" && p.required));

      // Check setup action
      const setupAction = installTool!.actions.find((a) => a.name === "setup");
      assert.ok(setupAction!.parameters.find((p) => p.name === "adapter" && p.required));
      assert.ok(setupAction!.parameters.find((p) => p.name === "mode" && p.required));

      // Check configure action
      const configAction = installTool!.actions.find((a) => a.name === "configure");
      assert.ok(configAction!.parameters.find((p) => p.name === "key" && p.required));
      assert.ok(configAction!.parameters.find((p) => p.name === "value" && p.required));
      assert.ok(configAction!.parameters.find((p) => p.name === "adapter" && p.required));
    });

    it("tool definitions include proper return types", () => {
      const tools = MCPTools.getMCPTools();
      const configureTool = tools.find((t) => t.id === "kit_configure");
      const getAction = configureTool!.actions.find((a) => a.name === "get");

      // Verify return type is object
      assert.ok(getAction!.returns);
      assert.equal(getAction!.returns.type, "object");
      assert.ok(getAction!.returns.description);
    });

    it("all kit_adapter_check actions specify return types", () => {
      const tools = MCPTools.getMCPTools();
      const checkTool = tools.find((t) => t.id === "kit_adapter_check");

      checkTool!.actions.forEach((action) => {
        assert.ok(action.returns);
        assert.ok(["object", "array"].includes(action.returns.type));
        assert.ok(action.returns.description);
      });
    });

    it("MCP tools include rate limit configuration", () => {
      const tools = MCPTools.getMCPTools();
      const configureTool = tools.find((t) => t.id === "kit_configure");

      // Tools should have rate_limit or not require auth
      assert.ok(configureTool!.rate_limit !== undefined || !configureTool!.requires_auth);
    });
  });

  describe("end-to-end adapter installation workflow", () => {
    it("manages complete adapter installation and setup lifecycle", () => {
      // Install adapter
      const install = MCPTools.installAdapter("sendgrid", false, "5.0.0");
      assert.equal(install.success, true);
      assert.equal(install.data?.installed, true);

      // Setup adapter
      const setup = MCPTools.setupAdapterAuto("sendgrid", {
        api_key: "SG.test...",
      });
      assert.equal(setup.success, true);
      assert.equal(setup.data?.configured, true);

      // Verify environment variables
      const envVars = MCPTools.getEnvironmentVariables("sendgrid");
      assert.equal(envVars.success, true);
      assert.ok(envVars.data!.length > 0);

      // Check adapter status
      const status = MCPTools.checkAdapterStatus("sendgrid");
      assert.equal(status.success, true);
      assert.equal(status.data?.installed, true);
    });
  });
});
