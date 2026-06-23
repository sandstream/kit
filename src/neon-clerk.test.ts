import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { neonDbAdapter } from "./adapters/neon-db.js";
import { clerkAuthAdapter } from "./adapters/clerk-auth.js";

const mockContext = (env: Record<string, string> = {}) => ({
  projectPath: "/tmp/test-project",
  projectName: "test-project",
  existingEnv: env,
});

describe("neonDbAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(neonDbAdapter.name, "neon/db");
    assert(neonDbAdapter.description.length > 0);
  });

  it("requires no CLI tools (API-based)", () => {
    assert.deepEqual(neonDbAdapter.getRequiredTools(), []);
  });

  it("check returns true when DATABASE_URL starts with postgresql://", async () => {
    const result = await neonDbAdapter.check(
      mockContext({ DATABASE_URL: "postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb" }),
    );
    assert.equal(result, true);
  });

  it("check returns true when DATABASE_URL starts with postgres://", async () => {
    const result = await neonDbAdapter.check(
      mockContext({ DATABASE_URL: "postgres://user:pass@host/db" }),
    );
    assert.equal(result, true);
  });

  it("check returns false when DATABASE_URL is absent", async () => {
    const result = await neonDbAdapter.check(mockContext());
    assert.equal(result, false);
  });

  it("check returns false when DATABASE_URL is not postgres", async () => {
    const result = await neonDbAdapter.check(
      mockContext({ DATABASE_URL: "mysql://user:pass@host/db" }),
    );
    assert.equal(result, false);
  });

  it("provision returns existing DATABASE_URL when already configured", async () => {
    const url = "postgresql://user:pass@ep-xxx.neon.tech/neondb";
    const result = await neonDbAdapter.provision(mockContext({ DATABASE_URL: url }));
    assert.equal(result.success, true);
    assert.equal(result.secrets?.DATABASE_URL, url);
    assert.equal(result.secrets?.NEON_DATABASE_URL, url);
    assert(result.message?.includes("already configured"));
  });

  it("provision returns error with setup instructions when NEON_API_KEY is missing", async () => {
    const result = await neonDbAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert(
      result.message?.includes("console.neon.tech"),
      `expected dashboard URL: ${result.message}`,
    );
    assert(result.message?.includes("NEON_API_KEY"), `expected key name: ${result.message}`);
  });
});

describe("clerkAuthAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(clerkAuthAdapter.name, "clerk/auth");
    assert(clerkAuthAdapter.description.length > 0);
  });

  it("requires no CLI tools", () => {
    assert.deepEqual(clerkAuthAdapter.getRequiredTools(), []);
  });

  it("check returns true when both Clerk keys are present", async () => {
    const result = await clerkAuthAdapter.check(
      mockContext({
        CLERK_SECRET_KEY: "sk_test_xxx",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_xxx",
      }),
    );
    assert.equal(result, true);
  });

  it("check returns false when keys are missing", async () => {
    const result = await clerkAuthAdapter.check(mockContext());
    assert.equal(result, false);
  });

  it("check returns false when only one key is present", async () => {
    const result = await clerkAuthAdapter.check(mockContext({ CLERK_SECRET_KEY: "sk_test_xxx" }));
    assert.equal(result, false);
  });

  it("provision returns success when keys already in environment", async () => {
    const result = await clerkAuthAdapter.provision(
      mockContext({
        CLERK_SECRET_KEY: "sk_test_xxx",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_xxx",
      }),
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.CLERK_SECRET_KEY, "sk_test_xxx");
    assert.equal(result.secrets?.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, "pk_test_xxx");
  });

  it("provision returns manual steps when keys are missing", async () => {
    const result = await clerkAuthAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert(result.message?.includes("dashboard.clerk.com"));
    assert(result.message?.includes("CLERK_SECRET_KEY"));
  });

  it("provision includes dashboard URL in manual steps", async () => {
    const result = await clerkAuthAdapter.provision(mockContext());
    assert(result.message?.includes("https://dashboard.clerk.com"));
  });
});
