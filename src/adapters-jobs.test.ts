/**
 * Tests for Trigger.dev, Inngest, and Flagsmith adapters
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { triggerBackgroundAdapter } from "./adapters/trigger-background.js";
import { inngestBackgroundAdapter } from "./adapters/inngest-background.js";
import { flagsmithFlagsAdapter } from "./adapters/flagsmith-flags.js";

const mockContext = (env: Record<string, string> = {}, projectName?: string) => ({
  projectPath: "/tmp/test-project",
  projectName,
  existingEnv: env,
});

// ─── Trigger.dev ──────────────────────────────────────────────────────────────

describe("triggerBackgroundAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(triggerBackgroundAdapter.name, "trigger/background");
    assert.ok(triggerBackgroundAdapter.description.length > 0);
  });

  it("requires no CLI tools", () => {
    assert.deepEqual(triggerBackgroundAdapter.getRequiredTools(), []);
  });

  it("check returns true when TRIGGER_SECRET_KEY starts with tr_", async () => {
    const result = await triggerBackgroundAdapter.check(
      mockContext({ TRIGGER_SECRET_KEY: "tr_prod_abc123" }),
    );
    assert.equal(result, true);
  });

  it("check returns false when TRIGGER_SECRET_KEY is absent", async () => {
    assert.equal(await triggerBackgroundAdapter.check(mockContext()), false);
  });

  it("check returns false when key does not start with tr_", async () => {
    const result = await triggerBackgroundAdapter.check(
      mockContext({ TRIGGER_SECRET_KEY: "sk_not_trigger" }),
    );
    assert.equal(result, false);
  });

  it("provision returns existing key when TRIGGER_SECRET_KEY is valid", async () => {
    const result = await triggerBackgroundAdapter.provision(
      mockContext({ TRIGGER_SECRET_KEY: "tr_prod_valid_key" }),
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.TRIGGER_SECRET_KEY, "tr_prod_valid_key");
    assert.ok(result.message.includes("already configured"));
  });

  it("provision includes default TRIGGER_API_URL when not set", async () => {
    const result = await triggerBackgroundAdapter.provision(
      mockContext({ TRIGGER_SECRET_KEY: "tr_prod_valid_key" }),
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.TRIGGER_API_URL, "https://api.trigger.dev");
  });

  it("provision uses custom TRIGGER_API_URL when set", async () => {
    const result = await triggerBackgroundAdapter.provision(
      mockContext({
        TRIGGER_SECRET_KEY: "tr_self_hosted",
        TRIGGER_API_URL: "https://trigger.my-company.com",
      }),
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.TRIGGER_API_URL, "https://trigger.my-company.com");
  });

  it("provision returns error with setup instructions when key is missing", async () => {
    const result = await triggerBackgroundAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert.ok(
      result.message.includes("cloud.trigger.dev"),
      `expected dashboard URL: ${result.message}`,
    );
    assert.ok(
      result.message.includes("TRIGGER_SECRET_KEY"),
      `expected key name: ${result.message}`,
    );
  });
});

// ─── Inngest ──────────────────────────────────────────────────────────────────

describe("inngestBackgroundAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(inngestBackgroundAdapter.name, "inngest/background");
    assert.ok(inngestBackgroundAdapter.description.length > 0);
  });

  it("requires no CLI tools", () => {
    assert.deepEqual(inngestBackgroundAdapter.getRequiredTools(), []);
  });

  it("check returns true when both keys are present", async () => {
    const result = await inngestBackgroundAdapter.check(
      mockContext({
        INNGEST_EVENT_KEY: "evt_abc123",
        INNGEST_SIGNING_KEY: "sign_abc123",
      }),
    );
    assert.equal(result, true);
  });

  it("check returns false when either key is missing", async () => {
    assert.equal(await inngestBackgroundAdapter.check(mockContext()), false);
    assert.equal(
      await inngestBackgroundAdapter.check(mockContext({ INNGEST_EVENT_KEY: "evt_123" })),
      false,
    );
    assert.equal(
      await inngestBackgroundAdapter.check(mockContext({ INNGEST_SIGNING_KEY: "sign_123" })),
      false,
    );
  });

  it("provision returns existing keys when both are present", async () => {
    const result = await inngestBackgroundAdapter.provision(
      mockContext({
        INNGEST_EVENT_KEY: "evt_existing",
        INNGEST_SIGNING_KEY: "sign_existing",
      }),
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.INNGEST_EVENT_KEY, "evt_existing");
    assert.equal(result.secrets?.INNGEST_SIGNING_KEY, "sign_existing");
    assert.ok(result.message.includes("already configured"));
  });

  it("provision returns error with setup instructions when keys are missing", async () => {
    const result = await inngestBackgroundAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert.ok(
      result.message.includes("app.inngest.com"),
      `expected dashboard URL: ${result.message}`,
    );
    assert.ok(result.message.includes("INNGEST_EVENT_KEY"), `expected key name: ${result.message}`);
    assert.ok(
      result.message.includes("INNGEST_SIGNING_KEY"),
      `expected key name: ${result.message}`,
    );
  });

  it("provision reports which keys are missing", async () => {
    const result = await inngestBackgroundAdapter.provision(
      mockContext({ INNGEST_EVENT_KEY: "evt_123" }),
    );
    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes("INNGEST_SIGNING_KEY"),
      `expected missing key: ${result.error}`,
    );
    assert.ok(
      !result.error?.includes("INNGEST_EVENT_KEY"),
      `should not list provided key: ${result.error}`,
    );
  });
});

// ─── Flagsmith ────────────────────────────────────────────────────────────────

describe("flagsmithFlagsAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(flagsmithFlagsAdapter.name, "flagsmith/flags");
    assert.ok(flagsmithFlagsAdapter.description.length > 0);
  });

  it("requires no CLI tools", () => {
    assert.deepEqual(flagsmithFlagsAdapter.getRequiredTools(), []);
  });

  it("check returns true when FLAGSMITH_ENVIRONMENT_KEY is present", async () => {
    const result = await flagsmithFlagsAdapter.check(
      mockContext({ FLAGSMITH_ENVIRONMENT_KEY: "env_abc123" }),
    );
    assert.equal(result, true);
  });

  it("check returns false when FLAGSMITH_ENVIRONMENT_KEY is absent", async () => {
    assert.equal(await flagsmithFlagsAdapter.check(mockContext()), false);
  });

  it("provision returns existing key when FLAGSMITH_ENVIRONMENT_KEY is set", async () => {
    const result = await flagsmithFlagsAdapter.provision(
      mockContext({ FLAGSMITH_ENVIRONMENT_KEY: "env_existing_key" }),
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.FLAGSMITH_ENVIRONMENT_KEY, "env_existing_key");
    assert.ok(result.message.includes("already configured"));
  });

  it("provision includes default API URL when not configured", async () => {
    const result = await flagsmithFlagsAdapter.provision(
      mockContext({ FLAGSMITH_ENVIRONMENT_KEY: "env_key" }),
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.FLAGSMITH_API_URL, "https://edge.api.flagsmith.com/api/v1/");
  });

  it("provision uses custom API URL for self-hosted instances", async () => {
    const result = await flagsmithFlagsAdapter.provision(
      mockContext({
        FLAGSMITH_ENVIRONMENT_KEY: "env_key",
        FLAGSMITH_API_URL: "https://flags.my-company.com/api/v1/",
      }),
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.FLAGSMITH_API_URL, "https://flags.my-company.com/api/v1/");
  });

  it("provision returns error with setup instructions when key is missing", async () => {
    const result = await flagsmithFlagsAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert.ok(
      result.message.includes("app.flagsmith.com"),
      `expected dashboard URL: ${result.message}`,
    );
    assert.ok(
      result.message.includes("FLAGSMITH_ENVIRONMENT_KEY"),
      `expected key name: ${result.message}`,
    );
  });
});
