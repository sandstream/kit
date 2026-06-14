import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReadOnlyMode,
  activateReadOnlyMode,
  refuseWrite,
  _resetReadOnlyModeForTests,
} from "./read-only-mode.js";

describe("read-only mode", () => {
  it("isReadOnlyMode is false when env var unset", () => {
    _resetReadOnlyModeForTests();
    assert.equal(isReadOnlyMode(), false);
  });

  it("honors KIT_READ_ONLY=1", () => {
    process.env.KIT_READ_ONLY = "1";
    try {
      assert.equal(isReadOnlyMode(), true);
    } finally {
      _resetReadOnlyModeForTests();
    }
  });

  it("honors KIT_READ_ONLY=true (string)", () => {
    process.env.KIT_READ_ONLY = "true";
    try {
      assert.equal(isReadOnlyMode(), true);
    } finally {
      _resetReadOnlyModeForTests();
    }
  });

  it("activateReadOnlyMode sets the env var", () => {
    _resetReadOnlyModeForTests();
    activateReadOnlyMode("flag");
    assert.equal(process.env.KIT_READ_ONLY, "1");
    assert.equal(isReadOnlyMode(), true);
    _resetReadOnlyModeForTests();
  });

  it("activateReadOnlyMode is idempotent", () => {
    _resetReadOnlyModeForTests();
    activateReadOnlyMode("flag");
    activateReadOnlyMode("flag"); // second call no-ops
    assert.equal(process.env.KIT_READ_ONLY, "1");
    _resetReadOnlyModeForTests();
  });

  it("refuseWrite returns structured failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ro-"));
    const prev = process.cwd();
    process.chdir(dir);
    try {
      _resetReadOnlyModeForTests();
      activateReadOnlyMode("flag");
      const result = await refuseWrite("test-op", { foo: "bar" });
      assert.equal(result.ok, false);
      assert.match(result.reason, /read-only mode active/);
      assert.match(result.reason, /"test-op"/);
    } finally {
      process.chdir(prev);
      _resetReadOnlyModeForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
