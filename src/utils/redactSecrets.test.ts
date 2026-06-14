import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./redactSecrets.js";

describe("redactSecrets", () => {
  it("redacts stripe test secret keys", () => {
    const out = redactSecrets(
      "test_mode_api_key = 'sk_test_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy'",
    );
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("sk_test_51T2AM"));
  });

  it("redacts stripe live keys + webhook secrets", () => {
    const out = redactSecrets(
      "sk_live_AbCdEfGhIjKlMnOpQrSt whsec_aaaaaaaaaaaaaaaaaaaaaa",
    );
    const matches = out.match(/\[REDACTED\]/g) || [];
    assert.equal(matches.length, 2);
  });

  it("redacts GitHub fine-grained PATs", () => {
    const out = redactSecrets(
      "auth: github_pat_11AAAAAAA0aaaaaaaaaaa_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    );
    assert.ok(out.includes("[REDACTED]"));
  });

  it("redacts AWS access key IDs", () => {
    const out = redactSecrets("AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE");
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("AKIAIOSFODNN7"));
  });

  it("redacts JWTs (anon/service-role keys)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36";
    const out = redactSecrets(`SUPABASE_KEY=${jwt}`);
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("eyJhbGciOiJ"));
  });

  it("redacts Resend keys", () => {
    // Real resend keys are re_ + ~24-char base62
    const out = redactSecrets("RESEND_API_KEY=re_AbC123XyZ789DefGhIjKlMn");
    assert.ok(out.includes("[REDACTED]"));
  });

  it("preserves harmless text", () => {
    const out = redactSecrets("color = '' project-name = 'default' device_name = 'host'");
    assert.equal(out, "color = '' project-name = 'default' device_name = 'host'");
  });

  it("preserves git commit hashes (40-hex)", () => {
    const out = redactSecrets("commit 33999d7e8f9a1234abcd5678901234567890abcd merged");
    assert.ok(out.includes("33999d7"));
  });

  it("handles empty input", () => {
    assert.equal(redactSecrets(""), "");
  });
});
