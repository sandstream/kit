/**
 * Split out of cli.test.ts: the `kit init` tests spawn the CLI and are among its slowest tests. Kept in one file,
 * cli.test.js ran serially for about a minute alone and timed out at 180 s under CI's parallel load.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GITIGNORE_CONTENT, runCli } from "./cli-run.test-support.js";

// ---------------------------------------------------------------------------
// kit init — auto-generate .kit.toml
// ---------------------------------------------------------------------------

describe("kit init — auto-generate", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-init-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("generates .kit.toml for a Next.js project when file is absent (--non-interactive)", async () => {
    const projectDir = join(tempDir, "nextjs-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    const result = await runCli(["init", "--non-interactive"], projectDir);

    // Should have generated .kit.toml
    const tomlContent = await readFile(join(projectDir, ".kit.toml"), "utf-8");
    assert.ok(tomlContent.length > 0, "should generate non-empty .kit.toml");
    assert.ok(tomlContent.includes("node"), "should include node in tools");
    assert.ok(result.stdout.includes(".kit.toml"), `expected generation message: ${result.stdout}`);
  });

  it("shows diff preview with + lines before writing", async () => {
    const projectDir = join(tempDir, "preview-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    const result = await runCli(["init", "--non-interactive"], projectDir);
    assert.ok(result.stdout.includes("Preview"), `expected preview header: ${result.stdout}`);
    assert.ok(result.stdout.includes(".kit.toml"), `expected preview content: ${result.stdout}`);
  });

  it("generates --yes as alias for --non-interactive", async () => {
    const projectDir = join(tempDir, "yes-flag-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    await runCli(["init", "--yes"], projectDir);
    const tomlContent = await readFile(join(projectDir, ".kit.toml"), "utf-8").catch(() => "");
    assert.ok(tomlContent.length > 0, "--yes should write .kit.toml");
  });

  it("does not overwrite existing .kit.toml", async () => {
    const projectDir = join(tempDir, "existing-config");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    const originalContent = `# existing config\n[tools]\nnode = "18"\n`;
    await writeFile(join(projectDir, ".kit.toml"), originalContent, "utf-8");

    await runCli(["init", "--non-interactive"], projectDir);

    // Existing file should be unchanged
    const tomlContent = await readFile(join(projectDir, ".kit.toml"), "utf-8");
    assert.equal(tomlContent, originalContent, "should not overwrite existing .kit.toml");
  });

  it("returns non-zero when confidence too low in non-interactive mode", async () => {
    const projectDir = join(tempDir, "empty-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
    // No package.json, no known files — confidence will be 0

    const result = await runCli(["init", "--non-interactive"], projectDir);
    assert.equal(result.exitCode, 1, "should exit 1 when confidence too low");
  });
});
