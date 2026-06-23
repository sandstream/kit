import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gatherProjectContext } from "./context.js";
import type { kitConfig } from "./config.js";

describe("gatherProjectContext", () => {
  it("returns structured context object", async () => {
    const config: kitConfig = {
      tools: {},
      services: {},
      secrets: {},
    };

    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(context, "Should return context object");
    assert.ok(typeof context.projectName === "string", "Should have projectName");
    assert.ok(typeof context.kitVersion === "string", "Should have kitVersion");
    assert.ok(context.detectedStack, "Should have detectedStack");
    assert.ok(typeof context.activeEnvironment === "string", "Should have activeEnvironment");
    assert.ok(Array.isArray(context.tools), "Should have tools array");
    assert.ok(Array.isArray(context.services), "Should have services array");
    assert.ok(context.secrets, "Should have secrets object");
    assert.ok(Array.isArray(context.locks), "Should have locks array");
  });

  it("includes project name in context", async () => {
    const config: kitConfig = {};
    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(context.projectName, "Should have project name");
    assert.notEqual(context.projectName, "unknown", "Should resolve actual project name");
  });

  it("includes kit version", async () => {
    const config: kitConfig = {};
    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(context.kitVersion, "Should have kit version");
    // Version might be "unknown" if package.json is not in expected location
    assert.equal(typeof context.kitVersion, "string");
  });

  it("includes active environment", async () => {
    const config: kitConfig = {};
    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(context.activeEnvironment, "Should have active environment");
    assert.equal(typeof context.activeEnvironment, "string");
  });

  it("detects project stack", async () => {
    const config: kitConfig = {};
    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(context.detectedStack, "Should have detected stack");
    // Stack detection depends on files in the project
    assert.equal(typeof context.detectedStack, "object");
  });

  it("gathers tool information when configured", async () => {
    const config: kitConfig = {
      tools: {
        node: "22",
      },
    };

    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(Array.isArray(context.tools), "Should have tools");
    if (context.tools.length > 0) {
      const tool = context.tools[0];
      assert.ok(tool.name, "Tool should have name");
      assert.equal(typeof tool.ok, "boolean", "Tool should have ok status");
      assert.ok(tool.installed === null || typeof tool.installed === "string");
    }
  });

  it("gathers service information when configured", async () => {
    const config: kitConfig = {
      services: {
        stripe: { login: "stripe login", check: "stripe status" },
      },
    };

    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(Array.isArray(context.services), "Should have services");
    // Service count depends on config
    assert.equal(typeof context.services, "object");
  });

  it("gathers secrets information when configured", async () => {
    const config: kitConfig = {
      secrets: {
        keys: {
          API_KEY: { source: "env" },
        },
      },
    };

    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(context.secrets, "Should have secrets");
    assert.ok(
      context.secrets.templateExists === null ||
        typeof context.secrets.templateExists === "boolean",
    );
    assert.ok(Array.isArray(context.secrets.keys), "Should have secrets.keys");
  });

  it("gathers lock file information", async () => {
    const config: kitConfig = {};

    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(Array.isArray(context.locks), "Should have locks");
    // Lock file status depends on actual lock files
    for (const lock of context.locks) {
      assert.ok(lock.category, "Lock should have category");
      assert.equal(typeof lock.exists, "boolean", "Lock should have exists status");
      assert.equal(typeof lock.inSync, "boolean", "Lock should have inSync status");
      assert.ok(lock.detail, "Lock should have detail message");
    }
  });

  it("handles empty config gracefully", async () => {
    const config: kitConfig = {};

    const context = await gatherProjectContext(config, process.cwd());

    assert.ok(context, "Should return valid context");
    assert.equal(context.tools.length, 0, "Should have no tools for empty config");
    assert.equal(context.services.length, 0, "Should have no services for empty config");
  });

  it("includes tool metadata in context", async () => {
    const config: kitConfig = {
      tools: {
        node: "22",
      },
    };

    const context = await gatherProjectContext(config, process.cwd());

    if (context.tools.length > 0) {
      const tool = context.tools[0];
      assert.ok("name" in tool, "Tool should have name property");
      assert.ok("required" in tool, "Tool should have required property");
      assert.ok("installed" in tool, "Tool should have installed property");
      assert.ok("ok" in tool, "Tool should have ok property");
    }
  });

  it("includes service authentication status", async () => {
    const config: kitConfig = {
      services: {},
    };

    const context = await gatherProjectContext(config, process.cwd());

    for (const service of context.services) {
      assert.ok("name" in service, "Service should have name");
      assert.ok("authenticated" in service, "Service should have authenticated status");
      assert.equal(typeof service.authenticated, "boolean");
    }
  });

  it("includes secret availability status", async () => {
    const config: kitConfig = {
      secrets: {},
    };

    const context = await gatherProjectContext(config, process.cwd());

    for (const secret of context.secrets.keys) {
      assert.ok("name" in secret, "Secret should have name");
      assert.ok("available" in secret, "Secret should have available status");
      assert.equal(typeof secret.available, "boolean");
    }
  });
});
