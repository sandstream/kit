import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  redactSecrets,
  safeStatusLine,
  findSecrets,
  shannonEntropy,
  SECRET_PATTERNS,
  SECRET_SHAPE_COUNT,
  secretShapeLabels,
} from "./redactSecrets.js";

describe("findSecrets — entropy backstop (fail-closed shared-memory gate)", () => {
  const has = (text: string, opts?: { entropyBackstop?: boolean }) =>
    findSecrets(text, opts).some((f) => f.label === "high-entropy-kv");

  it("catches a high-entropy value under an allowlisted env prefix (the gap)", () => {
    // KIT_/GITHUB_ are allowlisted by the kv-secret regex, so the default scan
    // misses this — the backstop must catch it.
    const leak = "KIT_SECRET=xQ9fL2vN8pR4tW6yA1bC3dE5gH7jK0mPzStV";
    assert.equal(has(leak), false, "default scan honors the prefix allowlist");
    assert.equal(has(leak, { entropyBackstop: true }), true, "backstop catches it");
    assert.equal(
      has("GITHUB_TOKENX=Zk3mP9qR7sT1vW5xY8aB2cD4eF6gH0jL", { entropyBackstop: true }),
      true,
    );
  });

  it("does NOT flag low-entropy or short values (no false positives)", () => {
    assert.equal(has("KIT_FLAG=development", { entropyBackstop: true }), false);
    assert.equal(has("KIT_MODE=production_environment_x", { entropyBackstop: true }), false);
    // a 64-char hex hash (e.g. KIT_POLICY_HASH) is ~4.0 bits/char — below threshold
    const hexHash = "a3f5c8e1b2d4f6a8c0e2b4d6f8a0c2e4a3f5c8e1b2d4f6a8c0e2b4d6f8a0c2e4";
    assert.equal(has(`KIT_POLICY_HASH=${hexHash}`, { entropyBackstop: true }), false);
  });

  it("shannonEntropy: low for repetitive, high for random", () => {
    assert.ok(shannonEntropy("aaaaaaaa") < 1);
    assert.ok(shannonEntropy("xQ9fL2vN8pR4tW6yA1bC3dE5") > 4.2);
  });
});

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

  // The GCP private-key pattern had two unbounded runs around a literal, so a blob
  // of near-miss `-----END ` tokens backtracked catastrophically (~18 KB hung ~17 s)
  // — a CPU DoS reachable via scan-staged / memory scan / status redaction.
  it("scans a hostile GCP-key-shaped blob in linear time (ReDoS-safe)", () => {
    const payload = '"private_key": "-----BEGIN K-----' + "-----END ".repeat(3000); // ~27 KB
    const t0 = process.hrtime.bigint();
    redactSecrets(payload);
    findSecrets(payload);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `GCP-shaped blob scanned in ${ms.toFixed(0)}ms — should be <200ms`);
  });

  it("still redacts a real GCP private_key value", () => {
    const real =
      '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\\n-----END PRIVATE KEY-----\\n"';
    assert.ok(redactSecrets(real).includes("[REDACTED]"));
  });
});

describe("redactSecrets — B3 coverage (PEM / cloud / url-token)", () => {
  it("redacts a raw (non-JSON) PEM private key block", () => {
    for (const kind of ["RSA ", "EC ", "OPENSSH ", ""]) {
      const pem = `-----BEGIN ${kind}PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END ${kind}PRIVATE KEY-----`;
      const out = redactSecrets(`key=${pem}`);
      assert.ok(out.includes("[REDACTED]"), kind);
      assert.ok(!out.includes("MIIEvQIBADANBg"), kind);
    }
    assert.deepEqual(
      findSecrets("-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----").map(
        (f) => f.label,
      ),
      ["pem-private-key"],
    );
  });

  it("redacts an Azure storage AccountKey but keeps AccountName", () => {
    const conn =
      "AccountName=devstore;AccountKey=" + "a".repeat(86) + "==;EndpointSuffix=core.windows.net";
    const out = redactSecrets(conn);
    assert.ok(out.includes("AccountName=devstore"));
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes("a".repeat(86)));
  });

  it("redacts SendGrid, Slack app-level, and npm tokens", () => {
    assert.ok(redactSecrets("SG.abcd1234efgh5678.ijkl9012mnop3456qrst").includes("[REDACTED]"));
    assert.ok(redactSecrets("xapp-1-A012B-345678-abcdef123456").includes("[REDACTED]"));
    assert.ok(redactSecrets("npm_" + "a".repeat(36)).includes("[REDACTED]"));
    // npm_config_* env vars are NOT tokens (underscore breaks the run) → no false positive
    assert.equal(redactSecrets("npm_config_registry=x"), "npm_config_registry=x");
  });

  it("redacts a token in the URL userinfo with no colon (git/registry PAT form)", () => {
    const out = redactSecrets("https://ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/o/r");
    assert.match(out, /https:\/\/\[REDACTED\]@github\.com/);
    // a short, non-secret username is left alone
    assert.equal(redactSecrets("https://peter@example.com"), "https://peter@example.com");
  });

  it("URL patterns are ReDoS-safe on a long hyphen/dot run with no scheme", () => {
    // The unbounded scheme run `[a-z0-9+.-]*` rescanned from every start looking for `://`
    // → O(n²). Bounding the scheme keeps it linear.
    const payload = "a-".repeat(100000); // 200 KB, no `://`
    const t0 = process.hrtime.bigint();
    redactSecrets(payload);
    findSecrets(payload);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `hyphen-run scanned in ${ms.toFixed(0)}ms — possible ReDoS`);
    // real connection strings still redact (incl. a long-ish scheme like mongodb+srv)
    assert.match(redactSecrets("mongodb+srv://u:passwordvalue@c.mongodb.net"), /\[REDACTED\]@/);
  });

  it("PEM matcher is ReDoS-safe on an unterminated near-miss body", () => {
    const payload = "-----BEGIN RSA PRIVATE KEY-----" + "A".repeat(200000);
    const t0 = process.hrtime.bigint();
    redactSecrets(payload);
    findSecrets(payload);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `PEM-shaped blob scanned in ${ms.toFixed(0)}ms — should be <200ms`);
  });
});

describe("redactSecrets — provider tokens (prefix-exclusion leak fix)", () => {
  it("redacts provider tokens previously skipped by the prefix allowlist", () => {
    for (const kv of [
      "VERCEL_TOKEN=xQ9fL2vN8pR4tW6yA1bC3dE5gH7jK0mP",
      "RAILWAY_TOKEN=Zk3mP9qR7sT1vW5xY8aB2cD4eF6gH0jL",
      "FLY_API_TOKEN=aB2cD4eF6gH0jLxQ9fL2vN8pR4tW6yA1",
      "GITHUB_TOKEN=ghXstuffZk3mP9qR7sT1vW5xY8aB2cD4eF",
      "CI_JOB_TOKEN=Zk3mP9qR7sT1vW5xY8aB2cD4eF6gH0jL9",
    ]) {
      const out = redactSecrets(kv);
      assert.ok(out.includes("[REDACTED]"), `should redact: ${kv}`);
      assert.ok(!out.includes(kv.split("=")[1]), `raw value must be gone: ${kv}`);
    }
  });

  it("still skips exact public CI/runtime metadata (no added noise)", () => {
    // exact metadata names + KIT_ flags are not credentials → left intact
    const meta =
      "GITHUB_SHA=a3f5c8e1b2d4f6a8c0e2b4d6f8a0c2e4a3f5c8e1 KIT_POLICY_HASH=deadbeefcafebabe0011";
    assert.equal(redactSecrets(meta), meta);
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

describe("findSecrets — Swedish personnummer (PII parity, Luhn-validated)", () => {
  const pnr = (text: string) => findSecrets(text).filter((f) => f.label === "swedish-personnummer");

  it("detects a valid personnummer in 10-digit (with separator) and 12-digit form", () => {
    assert.equal(pnr("patient 900101-1239 in the notes").length, 1);
    assert.equal(pnr("199001011239").length, 1);
  });

  it("masks the match — never echoes the full number", () => {
    const [f] = pnr("900101-1239");
    assert.ok(f && !f.preview.includes("011239"), "preview must not contain the full personnummer");
    assert.match(f.preview, /…/);
  });

  it("rejects a wrong check digit, an implausible date, and phone-shaped numbers (low FP)", () => {
    assert.equal(pnr("id 9001011230 here").length, 0); // wrong Luhn check digit
    assert.equal(pnr("ts 1234567890 log").length, 0); // MM=34 → not a date
    assert.equal(pnr("call 0701234567 now").length, 0); // phone-shaped, fails validation
    assert.equal(pnr("no pii in this line").length, 0);
  });
});

/**
 * The bound has to be derived, and it has to be sayable.
 *
 * Some tables must be hardcoded: nothing in a repository can tell you what a Stripe key looks
 * like. What must never be hidden is where such a table ends — "no secrets found" and "no secrets
 * of the kinds I know" are different statements, and only the second is true. So the count is
 * derived from the list rather than written down, because a written count is a claim that rots the
 * first time someone adds a pattern.
 *
 * Measured while adding this: a grep for `label:` said 29 shapes, the derived count says 25. The
 * grep counted the interface field and a doc line. That is the whole argument in one datum.
 */

describe("the detector's declared bound", () => {
  it("is derived from the pattern list, not written down", () => {
    assert.equal(SECRET_SHAPE_COUNT, SECRET_PATTERNS.length);
    assert.ok(SECRET_SHAPE_COUNT > 10, "a plausible detector, not an empty list");
  });

  it("names every shape exactly once, so a count and a list cannot disagree", () => {
    const labels = secretShapeLabels();
    assert.equal(new Set(labels).size, labels.length, "no duplicate labels");
    assert.deepEqual(labels, [...labels].sort(), "stable order for stable output");
    // Every pattern contributes a label: a nameless pattern could never be reported.
    for (const p of SECRET_PATTERNS) assert.ok(p.label.length > 0);
  });
});
