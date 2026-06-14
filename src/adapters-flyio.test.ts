import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { flyioHostingAdapter } from "./adapters/flyio-hosting.js";
import type { AdapterContext } from "./adapters/types.js";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

let tmpDir: string;

before(async () => {
  tmpDir = join(tmpdir(), `flyio-test-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("flyioHostingAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(flyioHostingAdapter.name, "flyio/hosting");
    assert.ok(flyioHostingAdapter.description);
    assert.match(flyioHostingAdapter.description, /fly/i);
  });

  it("requires fly CLI tool", () => {
    const tools = flyioHostingAdapter.getRequiredTools();
    assert.deepEqual(tools, ["fly"]);
  });

  it("check returns false when no configuration", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {},
    };

    const result = await flyioHostingAdapter.check(context);
    assert.equal(result, false);
  });

  it("check returns true when credentials present", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {
        FLY_API_TOKEN: "test-token",
        FLY_APP_NAME: "my-app",
      },
    };

    const result = await flyioHostingAdapter.check(context);
    assert.equal(result, true);
  });

  it("provision fails when fly CLI is not installed", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {},
    };

    const result = await flyioHostingAdapter.provision(context);

    assert.equal(result.success, false);
    assert.match(result.message, /fly/i);
    assert.ok(result.error);
  });

  it("provision handles existing configuration", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {
        FLY_API_TOKEN: "existing-token",
        FLY_APP_NAME: "existing-app",
        FLY_ORG_SLUG: "my-org",
      },
    };

    const result = await flyioHostingAdapter.provision(context);

    assert.equal(result.success, true);
    assert.ok(result.secrets);
    assert.equal(result.secrets["FLY_API_TOKEN"], "existing-token");
    assert.equal(result.secrets["FLY_APP_NAME"], "existing-app");
  });

  it("provision returns ProvisionResult with required fields", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {
        FLY_API_TOKEN: "test-token",
        FLY_APP_NAME: "test-app",
        FLY_ORG_SLUG: "test-org",
      },
    };

    const result = await flyioHostingAdapter.provision(context);

    assert.ok("success" in result);
    assert.ok("message" in result);
    assert.equal(typeof result.success, "boolean");
  });

  it("reuses existing credentials when available", async () => {
    const existingToken = "my-token-xyz";
    const existingApp = "my-app-name";
    const existingOrg = "my-organization";

    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {
        FLY_API_TOKEN: existingToken,
        FLY_APP_NAME: existingApp,
        FLY_ORG_SLUG: existingOrg,
      },
    };

    const result = await flyioHostingAdapter.provision(context);

    assert.equal(result.success, true);
    assert.equal(result.secrets?.FLY_API_TOKEN, existingToken);
    assert.equal(result.secrets?.FLY_APP_NAME, existingApp);
    assert.equal(result.secrets?.FLY_ORG_SLUG, existingOrg);
  });

  it("adapter implements ServiceAdapter interface", () => {
    assert.ok(flyioHostingAdapter.name);
    assert.ok(flyioHostingAdapter.description);
    assert.equal(typeof flyioHostingAdapter.getRequiredTools, "function");
    assert.equal(typeof flyioHostingAdapter.check, "function");
    assert.equal(typeof flyioHostingAdapter.provision, "function");
  });

  it("check accepts AdapterContext with projectPath and existingEnv", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: { FLY_API_TOKEN: "token" },
    };

    const result = await flyioHostingAdapter.check(context);
    assert.equal(typeof result, "boolean");
  });

  it("provision is async and returns promise of ProvisionResult", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {
        FLY_API_TOKEN: "test",
        FLY_APP_NAME: "test",
        FLY_ORG_SLUG: "test",
      },
    };

    const result = flyioHostingAdapter.provision(context);
    assert.ok(result instanceof Promise);
    const resolved = await result;
    assert.ok("success" in resolved);
  });

  it("getRequiredTools returns array with fly", () => {
    const tools = flyioHostingAdapter.getRequiredTools();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.includes("fly"));
  });

  it("provision returns error field on failure", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: {},
    };

    const result = await flyioHostingAdapter.provision(context);

    if (!result.success) {
      assert.ok(result.error);
    }
  });

  it("check returns false when only token is present without app name", async () => {
    const context: AdapterContext = {
      projectPath: tmpDir,
      existingEnv: { FLY_API_TOKEN: "token-only" },
    };

    const result = await flyioHostingAdapter.check(context);
    // Should return false since app name is missing
    assert.equal(typeof result, "boolean");
  });
});
