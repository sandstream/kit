import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  grantElevation,
  isElevated,
  readElevation,
  clearElevation,
  requireElevation,
  consumeElevation,
  _resetConsumedElevationForTests,
  generateTotp,
  verifyTotp,
  generateBase32Secret,
  buildOtpAuthUri,
  resolveTotpSecret,
} from "./elevation.js";
import { readFileSync, existsSync } from "node:fs";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-elev-"));
}

describe("grantElevation / isElevated", () => {
  it("grants and detects elevation for the scoped operation", async () => {
    const dir = tmpRepo();
    try {
      await grantElevation("rotate", "yes-prompt", dir);
      assert.equal(await isElevated("rotate", dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects scope mismatch", async () => {
    const dir = tmpRepo();
    try {
      await grantElevation("rotate", "yes-prompt", dir);
      assert.equal(await isElevated("migrate", dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scope='all' covers any operation", async () => {
    const dir = tmpRepo();
    try {
      await grantElevation("all", "yes-prompt", dir);
      assert.equal(await isElevated("rotate", dir), true);
      assert.equal(await isElevated("migrate", dir), true);
      assert.equal(await isElevated("onecli-register", dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expired markers don't elevate", async () => {
    const dir = tmpRepo();
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, ".kit"), { recursive: true });
      await writeFile(
        join(dir, ".kit", "elevation.json"),
        JSON.stringify({
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          scope: "all",
          granter: "t",
          method: "yes-prompt",
        }),
      );
      assert.equal(await isElevated("rotate", dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clearElevation", () => {
  it("removes an active elevation marker", async () => {
    const dir = tmpRepo();
    try {
      await grantElevation("all", "yes-prompt", dir);
      assert.ok(await readElevation(dir));
      await clearElevation(dir);
      assert.equal(await readElevation(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("requireElevation", () => {
  it("returns ok=false with helpful reason when no marker present", async () => {
    const dir = tmpRepo();
    try {
      const r = await requireElevation("rotate", dir);
      assert.equal(r.ok, false);
      assert.ok(r.reason.includes("auth elevate"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors KIT_ELEVATED=1 escape hatch", async () => {
    const prev = process.env.KIT_ELEVATED;
    try {
      process.env.KIT_ELEVATED = "1";
      const r = await requireElevation("rotate");
      assert.equal(r.ok, true);
      assert.ok(r.reason.includes("KIT_ELEVATED"));
    } finally {
      if (prev !== undefined) process.env.KIT_ELEVATED = prev;
      else delete process.env.KIT_ELEVATED;
    }
  });

  it("passes when scope matches and marker is fresh", async () => {
    const dir = tmpRepo();
    try {
      await grantElevation("rotate", "yes-prompt", dir);
      const r = await requireElevation("rotate", dir);
      assert.equal(r.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

describe("resolveTotpSecret", () => {
  it("returns env var when set", async () => {
    const prev = process.env.KIT_TOTP_SECRET;
    try {
      process.env.KIT_TOTP_SECRET = "FROM_ENV";
      assert.equal(await resolveTotpSecret(), "FROM_ENV");
    } finally {
      if (prev !== undefined) process.env.KIT_TOTP_SECRET = prev;
      else delete process.env.KIT_TOTP_SECRET;
    }
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
    // Step 0 vs step at current time — difference is in the millions,
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

describe("requireElevation audit emission", () => {
  it("writes an audit-log entry on the KIT_ELEVATED=1 bypass", async () => {
    const dir = tmpRepo();
    const prev = process.env.KIT_ELEVATED;
    process.env.KIT_ELEVATED = "1";
    _resetConsumedElevationForTests();
    try {
      const result = await requireElevation("rotate", dir);
      assert.equal(result.ok, true);
      const logPath = join(dir, ".kit-audit.jsonl");
      assert.equal(existsSync(logPath), true, "audit log must exist");
      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!);
      assert.equal(last.operation, "elevation-check");
      assert.equal(last.success, true);
      assert.equal(last.metadata.method, "ci-env");
      assert.equal(last.metadata.requested_scope, "rotate");
    } finally {
      if (prev === undefined) delete process.env.KIT_ELEVATED;
      else process.env.KIT_ELEVATED = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes an audit-log entry on refusal (no marker)", async () => {
    const dir = tmpRepo();
    try {
      const result = await requireElevation("rotate", dir);
      assert.equal(result.ok, false);
      const lines = readFileSync(join(dir, ".kit-audit.jsonl"), "utf-8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!);
      assert.equal(last.operation, "elevation-check");
      assert.equal(last.success, false);
      assert.equal(last.metadata.method, "none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("consumeElevation (one-shot)", () => {
  it("only allows one consume per process for the same scope", async () => {
    const dir = tmpRepo();
    _resetConsumedElevationForTests();
    const prev = process.env.KIT_ELEVATED;
    process.env.KIT_ELEVATED = "1";
    try {
      const first = await consumeElevation("rotate", dir);
      assert.equal(first.ok, true);
      const second = await consumeElevation("rotate", dir);
      assert.equal(second.ok, false);
      assert.match(second.reason, /already consumed/);
    } finally {
      if (prev === undefined) delete process.env.KIT_ELEVATED;
      else process.env.KIT_ELEVATED = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes the on-disk marker after consume", async () => {
    const dir = tmpRepo();
    _resetConsumedElevationForTests();
    try {
      await grantElevation("rotate", "yes-prompt", dir);
      assert.notEqual(await readElevation(dir), null);
      const result = await consumeElevation("rotate", dir);
      assert.equal(result.ok, true);
      assert.equal(await readElevation(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("elevation marker forgery resistance", () => {
  it("rejects an unsigned forged marker", async () => {
    const dir = tmpRepo();
    try {
      mkdirSync(join(dir, ".kit"), { recursive: true });
      // What an attacker / runaway agent with project write access would write:
      // a future-dated, broad-scope marker — but with no HMAC signature.
      const future = new Date(Date.now() + 60 * 60_000).toISOString();
      writeFileSync(
        join(dir, ".kit", "elevation.json"),
        JSON.stringify({ expiresAt: future, scope: "all", granter: "attacker", method: "totp" }),
      );
      assert.equal(await readElevation(dir), null);
      assert.equal(await isElevated("rotate", dir), false);
      assert.equal((await requireElevation("rotate", dir)).ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a tampered marker (mutated scope breaks the signature)", async () => {
    const dir = tmpRepo();
    try {
      // Legit grant for a narrow scope, then try to escalate scope in the file.
      await grantElevation("rotate", "yes-prompt", dir);
      const path = join(dir, ".kit", "elevation.json");
      const marker = JSON.parse(readFileSync(path, "utf-8"));
      marker.scope = "all"; // privilege-escalation attempt; signature no longer matches
      writeFileSync(path, JSON.stringify(marker));
      assert.equal(await readElevation(dir), null);
      assert.equal((await requireElevation("purge-history", dir)).ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
