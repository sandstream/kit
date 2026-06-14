import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tinybirdAnalyticsAdapter } from "./adapters/tinybird-analytics.js";
import { posthogAnalyticsAdapter } from "./adapters/posthog-analytics.js";

const mockContext = (env: Record<string, string> = {}) => ({
  projectPath: "/tmp/test-project",
  projectName: "test-project",
  existingEnv: env,
});

describe("tinybirdAnalyticsAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(tinybirdAnalyticsAdapter.name, "tinybird/analytics");
    assert(tinybirdAnalyticsAdapter.description.length > 0);
  });

  it("requires no CLI tools (API-based)", () => {
    assert.deepEqual(tinybirdAnalyticsAdapter.getRequiredTools(), []);
  });

  it("check returns true when TINYBIRD_TOKEN is present", async () => {
    const result = await tinybirdAnalyticsAdapter.check(
      mockContext({ TINYBIRD_TOKEN: "p.eyJhbGciOiJIUzI1NiJ9.xxx" })
    );
    assert.equal(result, true);
  });

  it("check returns false when TINYBIRD_TOKEN is absent", async () => {
    const result = await tinybirdAnalyticsAdapter.check(mockContext());
    assert.equal(result, false);
  });

  it("provision returns existing token when already configured", async () => {
    const token = "p.eyJhbGciOiJIUzI1NiJ9.xxx";
    const result = await tinybirdAnalyticsAdapter.provision(
      mockContext({ TINYBIRD_TOKEN: token })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.TINYBIRD_TOKEN, token);
    assert.equal(result.secrets?.TINYBIRD_API_URL, "https://api.tinybird.co");
    assert(result.message?.includes("already configured"));
  });

  it("provision uses custom TINYBIRD_API_URL when provided", async () => {
    const token = "p.eyJhbGciOiJIUzI1NiJ9.xxx";
    const apiUrl = "https://api.eu.tinybird.co";
    const result = await tinybirdAnalyticsAdapter.provision(
      mockContext({ TINYBIRD_TOKEN: token, TINYBIRD_API_URL: apiUrl })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.TINYBIRD_API_URL, apiUrl);
  });

  it("provision returns error with setup instructions when token is missing", async () => {
    const result = await tinybirdAnalyticsAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert(result.message?.includes("app.tinybird.co"), `expected dashboard URL: ${result.message}`);
    assert(result.message?.includes("TINYBIRD_TOKEN"), `expected key name: ${result.message}`);
  });
});

describe("posthogAnalyticsAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(posthogAnalyticsAdapter.name, "posthog/analytics");
    assert(posthogAnalyticsAdapter.description.length > 0);
  });

  it("requires no CLI tools (API-based)", () => {
    assert.deepEqual(posthogAnalyticsAdapter.getRequiredTools(), []);
  });

  it("check returns true when NEXT_PUBLIC_POSTHOG_KEY is present", async () => {
    const result = await posthogAnalyticsAdapter.check(
      mockContext({ NEXT_PUBLIC_POSTHOG_KEY: "phc_abc123" })
    );
    assert.equal(result, true);
  });

  it("check returns false when NEXT_PUBLIC_POSTHOG_KEY is absent", async () => {
    const result = await posthogAnalyticsAdapter.check(mockContext());
    assert.equal(result, false);
  });

  it("provision returns existing key when already configured", async () => {
    const apiKey = "phc_abc123";
    const result = await posthogAnalyticsAdapter.provision(
      mockContext({ NEXT_PUBLIC_POSTHOG_KEY: apiKey })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.NEXT_PUBLIC_POSTHOG_KEY, apiKey);
    assert.equal(result.secrets?.NEXT_PUBLIC_POSTHOG_HOST, "https://us.i.posthog.com");
    assert(result.message?.includes("already configured"));
  });

  it("provision uses custom NEXT_PUBLIC_POSTHOG_HOST when provided", async () => {
    const apiKey = "phc_abc123";
    const host = "https://eu.i.posthog.com";
    const result = await posthogAnalyticsAdapter.provision(
      mockContext({ NEXT_PUBLIC_POSTHOG_KEY: apiKey, NEXT_PUBLIC_POSTHOG_HOST: host })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.NEXT_PUBLIC_POSTHOG_HOST, host);
  });

  it("provision returns error with setup instructions when key is missing", async () => {
    const result = await posthogAnalyticsAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert(result.message?.includes("app.posthog.com"), `expected dashboard URL: ${result.message}`);
    assert(result.message?.includes("NEXT_PUBLIC_POSTHOG_KEY"), `expected key name: ${result.message}`);
  });
});
