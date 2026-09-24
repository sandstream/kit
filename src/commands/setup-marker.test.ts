import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { recordFirstInstallPrompt } from "./setup-marker.js";

it("first-install marker creation leaves a dangling symlink and its target untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-setup-marker-"));
  try {
    const marker = join(dir, "first-install-prompted");
    symlinkSync("unrelated", marker);
    await recordFirstInstallPrompt(marker);
    assert.equal(lstatSync(marker).isSymbolicLink(), true);
    assert.equal(existsSync(join(dir, "unrelated")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("first-install marker is created once with owner-only permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-setup-marker-"));
  try {
    const marker = join(dir, "first-install-prompted");
    await recordFirstInstallPrompt(marker);
    const first = readFileSync(marker, "utf8");
    await recordFirstInstallPrompt(marker);
    assert.equal(readFileSync(marker, "utf8"), first);
    if (process.platform !== "win32") assert.equal(lstatSync(marker).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
