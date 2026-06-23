import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, mkdir, rmdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor } from "./doctor.js";

describe("runDoctor", () => {
  it("returns skip for Node.js check when no package.json exists", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-1`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({}, tmpDir);
      const nodeCheck = result.checks.find((c) => c.name === "Node.js version");
      assert.ok(nodeCheck, "Node.js version check should exist");
      assert.equal(nodeCheck.status, "skip");
      assert.ok(
        nodeCheck.detail.includes("No package.json"),
        `unexpected detail: ${nodeCheck.detail}`,
      );
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("passes Node.js check when current version satisfies engines.node", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-2`);
    await mkdir(tmpDir, { recursive: true });
    const pkg = { engines: { node: ">=1.0.0" } }; // extremely low requirement, always passes
    await writeFile(join(tmpDir, "package.json"), JSON.stringify(pkg), "utf-8");
    try {
      const result = await runDoctor({}, tmpDir);
      const nodeCheck = result.checks.find((c) => c.name === "Node.js version");
      assert.ok(nodeCheck, "Node.js version check should exist");
      assert.equal(nodeCheck.status, "pass");
      assert.ok(
        nodeCheck.detail.includes("requires"),
        `detail should mention requirement: ${nodeCheck.detail}`,
      );
    } finally {
      await unlink(join(tmpDir, "package.json"));
      await rmdir(tmpDir);
    }
  });

  it("fails Node.js check when current version does not satisfy engines.node", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-3`);
    await mkdir(tmpDir, { recursive: true });
    const pkg = { engines: { node: ">=9999.0.0" } }; // impossibly high requirement
    await writeFile(join(tmpDir, "package.json"), JSON.stringify(pkg), "utf-8");
    try {
      const result = await runDoctor({}, tmpDir);
      const nodeCheck = result.checks.find((c) => c.name === "Node.js version");
      assert.ok(nodeCheck, "Node.js version check should exist");
      assert.equal(nodeCheck.status, "fail");
      assert.ok(
        nodeCheck.detail.includes("does not satisfy"),
        `unexpected detail: ${nodeCheck.detail}`,
      );
    } finally {
      await unlink(join(tmpDir, "package.json"));
      await rmdir(tmpDir);
    }
  });

  it("warns about missing .env.local when secrets section is configured", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-4`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({ secrets: { store: "1password" } }, tmpDir);
      const envCheck = result.checks.find((c) => c.name === ".env.local");
      assert.ok(envCheck, ".env.local check should exist when secrets configured");
      assert.equal(envCheck.status, "warn");
      assert.ok(
        envCheck.detail.includes("kit secrets"),
        `detail should suggest fix: ${envCheck.detail}`,
      );
    } finally {
      await rmdir(tmpDir);
    }
  });

  it("passes .env.local check when file exists and secrets section is configured", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-5`);
    await mkdir(tmpDir, { recursive: true });
    const envPath = join(tmpDir, ".env.local");
    await writeFile(envPath, "SECRET=value\n", "utf-8");
    try {
      const result = await runDoctor({ secrets: { store: "1password" } }, tmpDir);
      const envCheck = result.checks.find((c) => c.name === ".env.local");
      assert.ok(envCheck, ".env.local check should exist when secrets configured");
      assert.equal(envCheck.status, "pass");
    } finally {
      await unlink(envPath);
      await rmdir(tmpDir);
    }
  });

  it("skips .env.local check when no secrets section", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-6`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({}, tmpDir);
      const envCheck = result.checks.find((c) => c.name === ".env.local");
      assert.equal(envCheck, undefined, ".env.local check should not run without secrets config");
    } finally {
      await rmdir(tmpDir);
    }
  });

  it("includes mise check in every run", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-7`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const result = await runDoctor({}, tmpDir);
      const miseCheck = result.checks.find((c) => c.name === "mise");
      assert.ok(miseCheck, "mise check should always be present");
      assert.ok(
        miseCheck.status === "pass" || miseCheck.status === "warn",
        `mise check should be pass or warn, got: ${miseCheck.status}`,
      );
    } finally {
      await rmdir(tmpDir);
    }
  });

  it("correctly counts passed, warnings, and failed", async () => {
    const tmpDir = join(tmpdir(), `kit-doctor-test-${process.pid}-8`);
    await mkdir(tmpDir, { recursive: true });
    // Force a fail via impossible Node.js requirement and a warn via missing .env.local
    const pkg = { engines: { node: ">=9999.0.0" } };
    await writeFile(join(tmpDir, "package.json"), JSON.stringify(pkg), "utf-8");
    try {
      const result = await runDoctor({ secrets: { store: "env" } }, tmpDir);

      const total = result.passed + result.warnings + result.failed;
      const skipped = result.checks.filter((c) => c.status === "skip").length;
      assert.equal(total + skipped, result.checks.length, "counts should sum to total checks");

      assert.ok(result.failed >= 1, "should have at least 1 failure (Node.js version)");
      assert.ok(result.warnings >= 1, "should have at least 1 warning (.env.local missing)");
    } finally {
      await unlink(join(tmpDir, "package.json"));
      await rmdir(tmpDir);
    }
  });
});
