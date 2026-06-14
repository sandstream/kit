import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { railwayDeployAdapter } from "./railway-deploy.js";

const mockContext = (env: Record<string, string> = {}) => ({
  projectPath: "/tmp/test-railway-project",
  projectName: "test-app",
  existingEnv: env,
});

describe("railwayDeployAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(railwayDeployAdapter.name, "railway/deploy");
    assert(railwayDeployAdapter.description.length > 0);
  });

  it("requires railway CLI tool", () => {
    assert.deepEqual(railwayDeployAdapter.getRequiredTools(), ["railway"]);
  });

  it("check returns false when RAILWAY_PROJECT_ID is absent", async () => {
    const result = await railwayDeployAdapter.check(mockContext());
    assert.equal(result, false);
  });

  it("provision returns existing secrets when RAILWAY_PROJECT_ID already set", async () => {
    const result = await railwayDeployAdapter.provision(
      mockContext({
        RAILWAY_PROJECT_ID: "proj_abc123",
        RAILWAY_ENVIRONMENT: "staging",
      })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.["RAILWAY_PROJECT_ID"], "proj_abc123");
    assert.equal(result.secrets?.["RAILWAY_ENVIRONMENT"], "staging");
    assert(result.message?.includes("already configured"));
  });

  it("provision uses production as default environment", async () => {
    const result = await railwayDeployAdapter.provision(
      mockContext({ RAILWAY_PROJECT_ID: "proj_abc123" })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.["RAILWAY_ENVIRONMENT"], "production");
  });

  it("provision returns error when railway login fails", async () => {
    // railway CLI is not installed in test environment — expect provision to
    // attempt login and fail gracefully
    const result = await railwayDeployAdapter.provision(
      mockContext()
    );
    // Either login fails (CLI not installed) or init fails — either way, success=false
    // because we have no project ID and CLI isn't available
    assert.equal(result.success, false);
    assert(result.error, "should have an error field");
    assert(result.message, "should have a message field");
  });
});
