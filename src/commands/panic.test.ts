import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdPanic } from "./panic.js";
import { loadOrCreateIdentity, tryLoadIdentity, loadRevocations } from "../identity.js";

// kit panic reaches rotateIdentity() directly, whose guard is env-only. A policy-only
// mandate must still block it — otherwise panic re-mints exactly the same-UID file key the
// mandate forbids (verify Finding #2).
describe("kit panic — hardware mandate", () => {
  let idDir: string;
  let cwd: string;
  const saved = {
    id: process.env.KIT_IDENTITY_DIR,
    anchor: process.env.KIT_AUDIT_ANCHOR,
    argv: process.argv,
    cwd: process.cwd(),
  };

  beforeEach(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-panic-id-"));
    cwd = mkdtempSync(join(tmpdir(), "kit-panic-cwd-"));
    process.env.KIT_IDENTITY_DIR = idDir;
    process.env.KIT_AUDIT_ANCHOR = "0";
    delete process.env.KIT_REQUIRE_HARDWARE_IDENTITY;
  });
  afterEach(() => {
    process.env.KIT_IDENTITY_DIR = saved.id;
    if (saved.anchor === undefined) delete process.env.KIT_AUDIT_ANCHOR;
    else process.env.KIT_AUDIT_ANCHOR = saved.anchor;
    process.argv = saved.argv;
    process.chdir(saved.cwd);
    rmSync(idDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses to rotate (mint a file key) under a policy-only mandate", async () => {
    const id0 = loadOrCreateIdentity().identity; // identity exists BEFORE the policy
    writeFileSync(join(cwd, ".kit-policy.toml"), "version = 1\nrequire_hardware_identity = true\n");
    process.chdir(cwd); // getCurrentProjectRoot() → cwd (non-git temp) → finds the policy
    process.argv = ["node", "kit", "panic", "--no-checklist"];

    const ok = await cmdPanic();
    assert.equal(ok, false, "panic must fail closed under the mandate");
    // Identity was NOT rotated (no fresh file key minted) and nothing was revoked.
    assert.equal(tryLoadIdentity()?.id, id0.id, "identity must be unchanged (no rotation)");
    assert.equal(loadRevocations().length, 0, "no revocation recorded");
  });
});
