import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, safeStatusLine } from "./redactSecrets.js";

describe("redactSecrets — connection-string + sk-svcacct (regression)", () => {
  it("redacts the password in a DB URL but keeps scheme/user/host as context", () => {
    const out = redactSecrets("DATABASE_URL=postgres://app:S3cr3tPassw0rd@db.internal:5432/prod");
    assert.ok(!out.includes("S3cr3tPassw0rd"), "password must be gone");
    assert.match(out, /postgres:\/\/app:\[REDACTED\]@db\.internal/);
  });

  it("redacts a userless redis URL password", () => {
    const out = redactSecrets("redis://:topsecretvalue@cache.internal:6379");
    assert.ok(!out.includes("topsecretvalue"));
    assert.match(out, /\[REDACTED\]@cache\.internal/);
  });

  it("does not touch a plain URL with a port but no credentials", () => {
    const url = "https://api.example.com:8443/v1/health";
    assert.equal(redactSecrets(url), url);
  });

  it("redacts modern OpenAI sk-svcacct- / sk-admin- keys", () => {
    const out = redactSecrets("OPENAI_API_KEY=sk-svcacct-" + "A".repeat(24));
    assert.ok(!out.includes("AAAA"), "service-account key must be redacted");
    assert.ok(out.includes("[REDACTED]"));
  });
});

describe("redactSecrets", () => {
  it("redacts stripe test secret keys", () => {
    const out = redactSecrets("test_mode_api_key = 'sk_test_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy'");
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("sk_test_51T2AM"));
  });

  it("redacts stripe live keys + webhook secrets", () => {
    const out = redactSecrets("sk_live_AbCdEfGhIjKlMnOpQrSt whsec_aaaaaaaaaaaaaaaaaaaaaa");
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

describe("safeStatusLine", () => {
  it("collapses a multi-line check dump to the first non-empty line", () => {
    const dump = "color = ''\nproject-name = 'default'\n['acme']\naccount_id = 'acct_123'";
    assert.equal(safeStatusLine(dump), "color = ''");
  });

  it("skips leading blank lines", () => {
    assert.equal(safeStatusLine("\n\n  Logged in as octocat\nmore"), "Logged in as octocat");
  });

  it("redacts a secret that lands on the surfaced line", () => {
    // 24-char body → matches the canonical stripe pattern; built by concat so
    // no contiguous secret literal lands in source.
    const line = "key " + "sk_" + "test_" + "0123456789ABCDEFGHIJKLMN";
    const out = safeStatusLine(line);
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("0123456789ABCDEFGHIJKLMN"));
  });

  it("caps the line length", () => {
    assert.ok(safeStatusLine("x".repeat(200)).length <= 80);
    assert.equal(safeStatusLine("y".repeat(100), 60).length, 60);
  });

  it("returns empty string for empty/whitespace input", () => {
    assert.equal(safeStatusLine(""), "");
    assert.equal(safeStatusLine("\n  \n"), "");
  });
});
