import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, signWithIdentity, recordRevocation } from "../identity.js";
import { appendAuditEventDirect } from "../audit.js";

// The mandate must be COMPREHENSIVE: with KIT_REQUIRE_HARDWARE_IDENTITY set and only a
// file key present, NO code path may emit a file-key signature — not policy sign, not the
// audit chain, not revocations. Each either fails closed (throws) or falls back to keyless.
describe("hardware mandate — no file-key signature escapes", () => {
  let idDir: string;
  let cwd: string;
  const saved = {
    req: process.env.KIT_REQUIRE_HARDWARE_IDENTITY,
    id: process.env.KIT_IDENTITY_DIR,
    anchor: process.env.KIT_AUDIT_ANCHOR,
  };

  beforeEach(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-mandate-id-"));
    cwd = mkdtempSync(join(tmpdir(), "kit-mandate-cwd-"));
    process.env.KIT_IDENTITY_DIR = idDir;
    process.env.KIT_AUDIT_ANCHOR = "0"; // don't touch the real ~/.kit anchor from tests
    delete process.env.KIT_REQUIRE_HARDWARE_IDENTITY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries({
      KIT_REQUIRE_HARDWARE_IDENTITY: saved.req,
      KIT_IDENTITY_DIR: saved.id,
      KIT_AUDIT_ANCHOR: saved.anchor,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(idDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("signWithIdentity refuses the file key under the mandate", () => {
    loadOrCreateIdentity(); // a file key exists (created BEFORE the mandate)
    assert.doesNotThrow(() => signWithIdentity("x"), "no mandate → file signing works");
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.throws(() => signWithIdentity("x"), /required|refusing to sign/i);
  });

  it("loadOrCreateIdentity refuses to MINT a file key under the mandate", () => {
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.throws(() => loadOrCreateIdentity(), /refusing to create a file identity/);
  });

  it("recordRevocation fails closed under the mandate (no file-key revocation)", () => {
    loadOrCreateIdentity();
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.throws(
      () => recordRevocation("kid_target", "compromised"),
      /required|refusing to sign/i,
    );
  });

  it("audit entries fall back to KEYLESS under the mandate, never file-signed", async () => {
    loadOrCreateIdentity();
    const lastEntry = () => {
      const content = readFileSync(join(cwd, ".kit-audit.jsonl"), "utf-8");
      return JSON.parse(content.trim().split("\n").at(-1)!) as {
        operation: string;
        sig?: string;
        kid?: string;
      };
    };

    // Without the mandate, the entry is signed by the file identity.
    assert.equal(
      await appendAuditEventDirect(
        { operation: "op-a", environment: "dev", success: true },
        { cwd },
      ),
      true,
    );
    const signed = lastEntry();
    assert.ok(signed.sig && signed.kid, "pre-mandate entry carries a file-key signature");

    // With the mandate + only a file key: the append still SUCCEEDS (best-effort) but the
    // new entry is KEYLESS — no file-key signature is emitted.
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.equal(
      await appendAuditEventDirect(
        { operation: "op-b", environment: "dev", success: true },
        { cwd },
      ),
      true,
      "append must not fail — the hash chain still protects the entry",
    );
    const keyless = lastEntry();
    assert.equal(keyless.operation, "op-b");
    assert.equal(keyless.sig, undefined, "the mandated entry must NOT carry a file-key signature");
    assert.equal(keyless.kid, undefined);
  });
});
