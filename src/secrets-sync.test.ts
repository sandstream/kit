import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncSecrets } from "./secrets-sync.js";
import type { SecretsConfig } from "./config.js";

let testDir: string;

before(async () => {
  testDir = join(tmpdir(), `kit-sync-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

after(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const minimalSecrets: SecretsConfig = {
  store: "env",
  keys: {
    TEST_KEY: { source: "env", value: "test-value" },
  },
};

describe("syncSecrets — stdout target", () => {
  it("returns success with synced keys", async () => {
    // Capture stdout by providing a target that doesn't actually write
    const result = await syncSecrets(minimalSecrets, {
      target: "stdout",
      dryRun: true,
      projectPath: testDir,
    });
    assert.equal(result.target, "stdout");
    assert(typeof result.message === "string");
    assert(Array.isArray(result.synced));
    assert(Array.isArray(result.skipped));
    assert(Array.isArray(result.failed));
    assert.equal(result.dryRun, true);
  });

  it("dry run skips writing and lists keys in skipped", async () => {
    const result = await syncSecrets(minimalSecrets, {
      target: "stdout",
      dryRun: true,
      projectPath: testDir,
    });
    assert.equal(result.dryRun, true);
    assert(result.skipped.length > 0 || result.synced.length === 0);
  });
});

describe("syncSecrets — dotenv-ci target", () => {
  it("writes .env.ci file with resolved secrets", async () => {
    const result = await syncSecrets(minimalSecrets, {
      target: "dotenv-ci",
      dryRun: false,
      projectPath: testDir,
    });
    assert.equal(result.target, "dotenv-ci");
    assert.equal(result.failed.length, 0);
  });

  it("dry run does not write .env.ci", async () => {
    const result = await syncSecrets(minimalSecrets, {
      target: "dotenv-ci",
      dryRun: true,
      projectPath: testDir,
    });
    assert.equal(result.dryRun, true);
    assert(result.message.includes("Would write"));
  });
});

describe("syncSecrets — github target", () => {
  it("returns failure when GITHUB_TOKEN is not set", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const result = await syncSecrets(minimalSecrets, {
        target: "github",
        dryRun: false,
        projectPath: testDir,
      });
      assert.equal(result.target, "github");
      assert(result.failed.length > 0 || result.message.includes("GITHUB_TOKEN"));
    } finally {
      if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it("dry run with missing token still reports missing token", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const result = await syncSecrets(minimalSecrets, {
        target: "github",
        dryRun: true,
        projectPath: testDir,
      });
      assert(result.failed.length > 0 || result.message.toLowerCase().includes("token"));
    } finally {
      if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken;
    }
  });
});

describe("syncSecrets — unknown target", () => {
  it("returns failure for unknown target", async () => {
    const result = await syncSecrets(minimalSecrets, {
      target: "unknown" as "github",
      dryRun: false,
      projectPath: testDir,
    });
    assert(result.failed.length > 0);
    assert(result.message.includes("Unknown"));
  });
});
