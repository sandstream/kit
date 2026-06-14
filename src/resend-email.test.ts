import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resendEmailAdapter } from "./adapters/resend-email.js";

const mockContext = (env: Record<string, string> = {}, projectName?: string) => ({
  projectPath: "/tmp/test-project",
  projectName,
  existingEnv: env,
});

describe("resendEmailAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(resendEmailAdapter.name, "resend/email");
    assert.ok(resendEmailAdapter.description.length > 0);
  });

  it("requires no CLI tools", () => {
    assert.deepEqual(resendEmailAdapter.getRequiredTools(), []);
  });

  // ─── check() ────────────────────────────────────────────────────────────────

  it("check returns true when RESEND_API_KEY is present and starts with re_", async () => {
    const result = await resendEmailAdapter.check(
      mockContext({ RESEND_API_KEY: "re_abc123_validkey" })
    );
    assert.equal(result, true);
  });

  it("check returns false when RESEND_API_KEY is missing", async () => {
    assert.equal(await resendEmailAdapter.check(mockContext()), false);
  });

  it("check returns false when RESEND_API_KEY does not start with re_", async () => {
    const result = await resendEmailAdapter.check(
      mockContext({ RESEND_API_KEY: "sk_live_not_a_resend_key" })
    );
    assert.equal(result, false);
  });

  // ─── provision() — already configured ──────────────────────────────────────

  it("provision returns existing key when RESEND_API_KEY is valid", async () => {
    const result = await resendEmailAdapter.provision(
      mockContext({
        RESEND_API_KEY: "re_existing_abc123",
        RESEND_FROM_EMAIL: "hello@example.com",
      })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.RESEND_API_KEY, "re_existing_abc123");
    assert.equal(result.secrets?.RESEND_FROM_EMAIL, "hello@example.com");
    assert.ok(result.message.includes("already configured"));
  });

  it("provision uses default from email when RESEND_FROM_EMAIL is absent", async () => {
    const result = await resendEmailAdapter.provision(
      mockContext({ RESEND_API_KEY: "re_existing_abc123" })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.RESEND_FROM_EMAIL, "onboarding@resend.dev");
  });

  // ─── provision() — missing key ──────────────────────────────────────────────

  it("provision returns error with setup instructions when RESEND_API_KEY is missing", async () => {
    const result = await resendEmailAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert.ok(result.message.includes("resend.com/api-keys"), `expected dashboard URL in message: ${result.message}`);
    assert.ok(result.message.includes("RESEND_API_KEY"), `expected RESEND_API_KEY in message: ${result.message}`);
  });

  // ─── provision() — invalid key format ───────────────────────────────────────

  it("provision returns error when key does not start with re_", async () => {
    const result = await resendEmailAdapter.provision(
      mockContext({ RESEND_API_KEY: "not_a_resend_key_12345" })
    );
    assert.equal(result.success, false);
    assert.ok(
      result.error?.includes("does not look valid") || result.message.includes("re_"),
      `expected validation error, got: ${result.error} / ${result.message}`
    );
  });
});
