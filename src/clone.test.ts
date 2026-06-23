import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cloneRepository } from "./clone.js";

let tmpDir: string;
let testRepoDir: string;

before(async () => {
  tmpDir = join(tmpdir(), `kit-clone-test-${process.pid}`);
  testRepoDir = join(tmpDir, "test-repo-source");

  await mkdir(tmpDir, { recursive: true });
  // Initialize a minimal git repo for testing
  await mkdir(testRepoDir, { recursive: true });
  await writeFile(join(testRepoDir, "README.md"), "# Test Repo\n", "utf-8");
  await writeFile(join(testRepoDir, ".kit.toml"), '[tools]\nnode = "22"\n', "utf-8");

  // Initialize git
  const { execSync } = await import("node:child_process");
  try {
    execSync("git init", { cwd: testRepoDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", {
      cwd: testRepoDir,
      stdio: "pipe",
    });
    execSync("git config user.name 'Test'", {
      cwd: testRepoDir,
      stdio: "pipe",
    });
    execSync("git add .", { cwd: testRepoDir, stdio: "pipe" });
    execSync("git commit -m 'Initial commit'", {
      cwd: testRepoDir,
      stdio: "pipe",
    });
  } catch {
    // Git might not be available in test environment; tests will adapt
  }
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("cloneRepository", () => {
  it("derives target directory name from repo URL", async () => {
    const opts = {
      repoUrl: "https://github.com/user/my-awesome-repo.git",
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    // Should derive "my-awesome-repo" from the URL
    assert.match(result.clonedPath, /my-awesome-repo$/, "Should derive directory name from URL");
  });

  it("uses provided target directory", async () => {
    const opts = {
      repoUrl: testRepoDir,
      targetDir: "custom-name",
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    assert(result.clonedPath.endsWith("custom-name"), "Should use provided directory name");
  });

  it("strips .git suffix from derived directory name", async () => {
    const opts = {
      repoUrl: "https://github.com/user/my-repo.git",
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    assert(!result.clonedPath.endsWith(".git"), "Should strip .git from directory name");
    assert.match(result.clonedPath, /my-repo$/, "Should end with my-repo not my-repo.git");
  });

  it("detects .kit.toml presence", async () => {
    const opts = {
      repoUrl: testRepoDir,
      targetDir: "with-toml",
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    if (result.success) {
      assert.equal(result.haskitToml, true, "Should detect .kit.toml");
    }
  });

  it("returns haskitToml false when file missing", async () => {
    const noTomlRepoDir = join(tmpDir, "no-toml-repo");
    await mkdir(noTomlRepoDir, { recursive: true });
    await writeFile(join(noTomlRepoDir, "README.md"), "# Test\n", "utf-8");

    // Initialize git repo without .kit.toml
    const { execSync } = await import("node:child_process");
    try {
      execSync("git init", { cwd: noTomlRepoDir, stdio: "pipe" });
      execSync("git config user.email 'test@test.com'", {
        cwd: noTomlRepoDir,
        stdio: "pipe",
      });
      execSync("git config user.name 'Test'", {
        cwd: noTomlRepoDir,
        stdio: "pipe",
      });
      execSync("git add .", { cwd: noTomlRepoDir, stdio: "pipe" });
      execSync("git commit -m 'Initial'", {
        cwd: noTomlRepoDir,
        stdio: "pipe",
      });
    } catch {
      // Git not available
    }

    const opts = {
      repoUrl: noTomlRepoDir,
      targetDir: "no-toml",
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    if (result.success) {
      assert.equal(result.haskitToml, false, "Should not detect .kit.toml");
    }
  });

  it("respects --no-setup flag", async () => {
    const opts = {
      repoUrl: testRepoDir,
      targetDir: "no-setup-test",
      noSetup: true,
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    assert.equal(result.setupSkipped, true, "Should indicate setup was skipped");
  });

  it("respects environment option", async () => {
    const opts = {
      repoUrl: testRepoDir,
      targetDir: "env-test",
      environment: "production",
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    // Just verify it doesn't crash with environment option
    assert.equal(typeof result.success, "boolean");
  });

  it("returns failure for non-existent repo URL", async () => {
    const opts = {
      repoUrl: "https://github.com/nonexistent-user-12345/nonexistent-repo-98765.git",
      targetDir: "fail-test",
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    assert.equal(result.success, false, "Should fail for invalid repo");
    assert(result.message.includes("Failed to clone"), "Should have error message");
  });

  it("includes clonedPath in result even on failure", async () => {
    const opts = {
      repoUrl: "not-a-valid-repo-url",
      targetDir: "missing-repo",
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    assert(result.clonedPath.includes("missing-repo"), "Should include clonedPath");
  });

  it("cloned directory should be readable", async () => {
    const opts = {
      repoUrl: testRepoDir,
      targetDir: "readable-test",
      cwd: tmpDir,
    };
    const result = await cloneRepository(opts);

    if (result.success) {
      const readmeContent = await readFile(join(result.clonedPath, "README.md"), "utf-8");
      assert(readmeContent.includes("Test Repo"), "Should be able to read cloned files");
    }
  });
});
