import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOtpAuthUri,
  generateBase32Secret,
  generateTotp,
  verifyTotp,
} from "./elevation-totp.js";
import * as elevation from "./elevation.js";

describe("generateBase32Secret", () => {
  it("uses RFC 4648 base32 alphabet (no padding) at the expected length", () => {
    const s = generateBase32Secret(20);
    // 20 bytes → 160 bits → 32 base32 chars (no padding when bits % 5 == 0)
    assert.equal(s.length, 32);
    assert.ok(/^[A-Z2-7]+$/.test(s), `unexpected chars: ${s}`);
  });

  it("returns different secrets on each call", () => {
    assert.notEqual(generateBase32Secret(), generateBase32Secret());
  });
});

describe("buildOtpAuthUri", () => {
  it("includes secret + issuer + algorithm in the URI", () => {
    const uri = buildOtpAuthUri({
      accountName: "ralph@host",
      issuer: "kit",
      secret: "JBSWY3DPEHPK3PXP",
    });
    assert.ok(uri.startsWith("otpauth://totp/"));
    assert.ok(uri.includes("secret=JBSWY3DPEHPK3PXP"));
    assert.ok(uri.includes("issuer=kit"));
    assert.ok(uri.includes("algorithm=SHA1"));
    assert.ok(uri.includes("digits=6"));
    assert.ok(uri.includes("period=30"));
  });

  it("URL-encodes account + issuer in the label", () => {
    const uri = buildOtpAuthUri({
      accountName: "user with spaces@x",
      issuer: "My Issuer",
      secret: "AAAA",
    });
    // Label segment is "<issuer>:<account>", URL-encoded.
    assert.ok(uri.includes("My%20Issuer"));
    assert.ok(uri.includes("user%20with%20spaces"));
  });
});

describe("generateTotp / verifyTotp", () => {
  // RFC 6238 Appendix B test vectors (SHA-1, 8-byte counter, 30s).
  // The reference secret "12345678901234567890" base32-encodes to
  // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
  const TEST_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("generates 6-digit codes", () => {
    const code = generateTotp(TEST_SECRET, 0);
    assert.equal(code.length, 6);
    assert.ok(/^\d{6}$/.test(code));
  });

  it("verifies the current code", () => {
    const code = generateTotp(TEST_SECRET);
    assert.equal(verifyTotp(code, TEST_SECRET), true);
  });

  it("rejects malformed codes", () => {
    assert.equal(verifyTotp("abc", TEST_SECRET), false);
    assert.equal(verifyTotp("12345", TEST_SECRET), false);
    assert.equal(verifyTotp("1234567", TEST_SECRET), false);
  });

  it("rejects codes outside the verification window", () => {
    // Step 0 differs from the current step by millions of steps,
    // far outside the ±1 default window.
    const codeFromAgesAgo = generateTotp(TEST_SECRET, 0);
    assert.equal(verifyTotp(codeFromAgesAgo, TEST_SECRET), false);
  });

  it("matches the RFC 6238 reference vector at T=59 (step 1)", () => {
    // RFC 6238 Appendix B: T=59, K=ASCII"12345678901234567890" (SHA-1) → 94287082
    const ref = generateTotp(TEST_SECRET, 1);
    assert.equal(ref, "287082");
    // ^ kit returns last 6 digits (RFC 4226 default), so the truncation
    // matches the "94287082"[2..] = "287082" portion.
  });
});

it("preserves the elevation entry point for TOTP provisioning and verification", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(elevation.generateTotp(secret, 1), "287082");
  assert.equal(elevation.verifyTotp(elevation.generateTotp(secret), secret), true);
  assert.match(elevation.generateBase32Secret(), /^[A-Z2-7]{32}$/);
  const input: elevation.OtpAuthUriInput = { accountName: "synthetic@example.invalid", secret };
  const uri = new URL(elevation.buildOtpAuthUri(input));
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.searchParams.get("secret"), secret);
  assert.equal(uri.searchParams.get("issuer"), "kit");
});
