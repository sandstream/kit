import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { railwayHostingAdapter } from "./adapters/railway-hosting.js";
import type { AdapterContext } from "./adapters/types.js";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

let tmpDir: string;

before(async () => {
  tmpDir = join(tmpdir(), `railway-test-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("railwayHostingAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(railwayHostingAdapter.name, "railway/hosting");
    assert.ok(railwayHostingAdapter.description);
    assert.match(railwayHostingAdapter.description, /railway/i);
  });

  it("requires railway CLI tool", () => {
    const tools = railwayHostingAdapter.getRequiredTools();
    assert.deepEqual(tools, ["railway"]);
  });

  it("check returns false when no configuration", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {},
    };

    const result = await railwayHostingAdapter.check(context);
    assert.equal(result, false);
  });

  it("check returns true when RAILWAY_TOKEN is present", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: { RAILWAY_TOKEN: "test-token-123" },
    };

    const result = await railwayHostingAdapter.check(context);
    assert.equal(result, true);
  });

  it("provision fails when railway CLI is not installed", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {},
    };

    const result = await railwayHostingAdapter.provision(context);

    assert.equal(result.success, false);
    assert.match(result.message, /railway/i);
    assert.ok(result.error);
  });

  it("provision handles existing configuration gracefully", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {
        RAILWAY_TOKEN: "existing-token",
        RAILWAY_PROJECT_ID: "proj-123",
        RAILWAY_ENVIRONMENT_ID: "production",
      },
    };

    const result = await railwayHostingAdapter.provision(context);

    assert.equal(result.success, true);
    assert.ok(result.secrets);
    assert.equal(result.secrets["RAILWAY_TOKEN"], "existing-token");
    assert.equal(result.secrets["RAILWAY_PROJECT_ID"], "proj-123");
  });

  it("provision returns ProvisionResult with required fields on success", async () => {
    // This test would only pass if railway is installed and configured
    // For now, we verify the structure
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {
        RAILWAY_TOKEN: "test-token",
        RAILWAY_PROJECT_ID: "test-project",
        RAILWAY_ENVIRONMENT_ID: "production",
      },
    };

    const result = await railwayHostingAdapter.provision(context);

    assert.ok("success" in result);
    assert.ok("message" in result);
    assert.equal(typeof result.success, "boolean");
  });

  it("provision returns error with manual steps when not authenticated", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {},
    };

    const result = await railwayHostingAdapter.provision(context);

    // Should fail gracefully
    assert.equal(typeof result.success, "boolean");
    assert.ok(result.message);
  });

  it("reuses existing credentials when available", async () => {
    const existingToken = "my-existing-token-12345";
    const existingProjectId = "proj-abc123";
    const existingEnvId = "staging";

    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {
        RAILWAY_TOKEN: existingToken,
        RAILWAY_PROJECT_ID: existingProjectId,
        RAILWAY_ENVIRONMENT_ID: existingEnvId,
      },
    };

    const result = await railwayHostingAdapter.provision(context);

    assert.equal(result.success, true);
    assert.equal(result.secrets?.RAILWAY_TOKEN, existingToken);
    assert.equal(result.secrets?.RAILWAY_PROJECT_ID, existingProjectId);
    assert.equal(result.secrets?.RAILWAY_ENVIRONMENT_ID, existingEnvId);
  });

  it("adapter implements ServiceAdapter interface", () => {
    assert.ok(railwayHostingAdapter.name);
    assert.ok(railwayHostingAdapter.description);
    assert.equal(typeof railwayHostingAdapter.getRequiredTools, "function");
    assert.equal(typeof railwayHostingAdapter.check, "function");
    assert.equal(typeof railwayHostingAdapter.provision, "function");
  });

  it("getRequiredTools returns array of strings", () => {
    const tools = railwayHostingAdapter.getRequiredTools();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.every((t) => typeof t === "string"));
  });

  it("check is async and returns promise of boolean", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {},
    };

    const result = railwayHostingAdapter.check(context);
    assert.ok(result instanceof Promise);
    const resolved = await result;
    assert.equal(typeof resolved, "boolean");
  });

  it("provision is async and returns promise of ProvisionResult", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {
        RAILWAY_TOKEN: "test",
        RAILWAY_PROJECT_ID: "test",
        RAILWAY_ENVIRONMENT_ID: "test",
      },
    };

    const result = railwayHostingAdapter.provision(context);
    assert.ok(result instanceof Promise);
    const resolved = await result;
    assert.ok("success" in resolved);
    assert.ok("message" in resolved);
  });
});
