import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkLockFiles } from "./check-lock.js";
import { updateSkillsLock, updateCliLock, writeSkillsLock } from "./lock.js";
import type { kitConfig } from "./config.js";

let tempDir: string;
let originalCwd: string;

before(async () => {
  originalCwd = process.cwd();
  tempDir = await mkdtemp(join(tmpdir(), "kit-chklock-"));
  process.chdir(tempDir);
});

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(join(tempDir, ".kit"), { recursive: true, force: true });
});

describe("checkLockFiles", () => {
  it("returns empty results when config has no skills or tools", async () => {
    const config: kitConfig = {};
    const results = await checkLockFiles(config);
    assert.deepEqual(results, []);
  });

  it("reports skills-lock missing when lock file does not exist", async () => {
    const config: kitConfig = {
      skills: { required: { "my-skill": "1.0.0" } },
    };
    const results = await checkLockFiles(config);

    assert.equal(results.length, 1);
    assert.equal(results[0].category, "skills-lock");
    assert.equal(results[0].exists, false);
    assert.equal(results[0].inSync, false);
    assert.deepEqual(results[0].missing, ["my-skill"]);
  });

  it("reports cli-lock missing when lock file does not exist", async () => {
    const config: kitConfig = {
      tools: { node: "22" },
    };
    const results = await checkLockFiles(config);

    assert.equal(results.length, 1);
    assert.equal(results[0].category, "cli-lock");
    assert.equal(results[0].exists, false);
    assert.equal(results[0].inSync, false);
    assert.deepEqual(results[0].missing, ["node"]);
  });

  it("reports skills in sync when all configured skills are locked", async () => {
    await updateSkillsLock({ "skill-a": "1.0.0", "skill-b": "2.0.0" });

    const config: kitConfig = {
      skills: {
        required: { "skill-a": "1.0.0" },
        optional: { "skill-b": "2.0.0" },
      },
    };
    const results = await checkLockFiles(config);

    assert.equal(results.length, 1);
    assert.equal(results[0].category, "skills-lock");
    assert.equal(results[0].exists, true);
    assert.equal(results[0].inSync, true);
    assert.deepEqual(results[0].missing, []);
  });

  it("reports tools in sync when all configured tools are locked", async () => {
    await updateCliLock({
      node: { version: "22.0.0", source: "mise" },
      bun: { version: "1.2.0", source: "npm" },
    });

    const config: kitConfig = {
      tools: { node: "22", bun: "1" },
    };
    const results = await checkLockFiles(config);

    assert.equal(results.length, 1);
    assert.equal(results[0].category, "cli-lock");
    assert.equal(results[0].exists, true);
    assert.equal(results[0].inSync, true);
    assert.deepEqual(results[0].missing, []);
  });

  it("identifies missing skills when lock is partial", async () => {
    await updateSkillsLock({ "skill-a": "1.0.0" });

    const config: kitConfig = {
      skills: {
        required: { "skill-a": "1.0.0", "skill-b": "2.0.0" },
      },
    };
    const results = await checkLockFiles(config);

    assert.equal(results[0].inSync, false);
    assert.deepEqual(results[0].missing, ["skill-b"]);
  });

  it("identifies auth-required skills in detail message", async () => {
    await writeSkillsLock({
      version: 1,
      skills: {
        "private-skill": {
          source: "owner/private-skill",
          sourceType: "github",
          computedHash: "abc123",
          auth: "github",
          installedAt: "2026-01-01T00:00:00Z",
        },
      },
    });

    const config: kitConfig = {
      skills: { required: { "private-skill": "owner/private-skill" } },
    };
    const results = await checkLockFiles(config);

    assert.equal(results[0].inSync, true);
    assert.ok(results[0].authRequired?.includes("private-skill"));
    assert.ok(results[0].detail.includes("github"));
  });

  it("checks both skills and tools when both are configured", async () => {
    const config: kitConfig = {
      skills: { required: { "skill-a": "1.0.0" } },
      tools: { node: "22" },
    };
    const results = await checkLockFiles(config);

    assert.equal(results.length, 2);
    const categories = results.map((r) => r.category);
    assert.ok(categories.includes("skills-lock"));
    assert.ok(categories.includes("cli-lock"));
  });
});
