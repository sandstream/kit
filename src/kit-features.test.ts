import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { flagsForCommand } from "./flag-surface.js";
import { KIT_FEATURES } from "./kit-features.js";
import { buildStatuslineParts } from "./statusline.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("KIT_FEATURES: what this kit can do, for a UI that must not offer what is missing", () => {
  it("names the upstream watch and the image scan", () => {
    assert.ok(KIT_FEATURES.includes("upstream"));
    assert.ok(KIT_FEATURES.includes("image-scan"));
  });

  it("lists each feature once, in a stable order", () => {
    assert.equal(new Set(KIT_FEATURES).size, KIT_FEATURES.length);
    assert.deepEqual([...KIT_FEATURES], [...KIT_FEATURES].sort());
  });

  it("every feature that is a command is a command kit really has", () => {
    assert.ok(flagsForCommand("upstream") !== null, "upstream is declared in the flag surface");
  });

  it("kit statusline --json carries the list, so a UI asks kit and does not guess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-features-"));
    try {
      const parts = await buildStatuslineParts({ cwd: dir });
      assert.deepEqual(parts.features, [...KIT_FEATURES]);
    } finally {
      rmTemp(dir);
    }
  });
});
