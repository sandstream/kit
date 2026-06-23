import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkHooks, isGitRepository } from "./check-hooks.js";
import { installHooks } from "./hooks.js";
import type { HooksConfig } from "./config.js";

let tempDir: string;
let originalCwd: string;
let gitDir: string;

before(async () => {
  originalCwd = process.cwd();
  tempDir = await mkdtemp(join(tmpdir(), "kit-chkhooks-"));
  gitDir = join(tempDir, ".git");
  process.chdir(tempDir);
});

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(gitDir, { recursive: true, force: true });
});

describe("isGitRepository", () => {
  it("returns false when .git directory does not exist", () => {
    assert.equal(isGitRepository(), false);
  });

  it("returns true when .git directory exists", async () => {
    await mkdir(gitDir, { recursive: true });
    assert.equal(isGitRepository(), true);
  });

  it("accepts custom git dir path", async () => {
    const customGit = join(tempDir, ".custom-git");
    await mkdir(customGit, { recursive: true });
    assert.equal(isGitRepository(".custom-git"), true);
    await rm(customGit, { recursive: true, force: true });
  });
});

describe("checkHooks", () => {
  it("returns empty array when config has no hooks", async () => {
    const results = await checkHooks({} as HooksConfig);
    assert.deepEqual(results, []);
  });

  it("reports not installed when hook file does not exist", async () => {
    await mkdir(join(gitDir, "hooks"), { recursive: true });

    const config: HooksConfig = {
      "pre-commit": ["npm run lint"],
    };
    const results = await checkHooks(config);

    assert.equal(results.length, 1);
    assert.equal(results[0].hookName, "pre-commit");
    assert.equal(results[0].installed, false);
    assert.equal(results[0].upToDate, false);
    assert.ok(results[0].detail.includes("not installed"));
  });

  it("reports not managed by kit when hook lacks the marker", async () => {
    await mkdir(join(gitDir, "hooks"), { recursive: true });
    await writeFile(join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\nnpm test\n", "utf-8");

    const config: HooksConfig = { "pre-commit": ["npm test"] };
    const results = await checkHooks(config);

    assert.equal(results[0].installed, true);
    assert.equal(results[0].upToDate, false);
    assert.ok(results[0].detail.includes("not managed by kit"));
  });

  it("reports up to date when all commands are present in kit hook", async () => {
    // Use hooks.ts to install a real kit hook
    const config: HooksConfig = {
      "pre-commit": ["npm run lint", "npm run typecheck"],
    };
    await installHooks(config, gitDir);

    const results = await checkHooks(config);

    assert.equal(results.length, 1);
    assert.equal(results[0].hookName, "pre-commit");
    assert.equal(results[0].installed, true);
    assert.equal(results[0].upToDate, true);
    assert.ok(results[0].detail.includes("2 command(s)"));
  });

  it("reports outdated when hook is missing some commands", async () => {
    // Install with one command
    await installHooks({ "pre-commit": ["npm run lint"] }, gitDir);

    // Check against config expecting two commands
    const config: HooksConfig = {
      "pre-commit": ["npm run lint", "npm run typecheck"],
    };
    const results = await checkHooks(config);

    assert.equal(results[0].installed, true);
    assert.equal(results[0].upToDate, false);
    assert.ok(results[0].detail.includes("outdated"));
  });

  it("checks multiple hooks independently", async () => {
    const config: HooksConfig = {
      "pre-commit": ["npm run lint"],
      "pre-push": ["npm audit"],
    };
    await installHooks(config, gitDir);

    const results = await checkHooks(config);

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.upToDate));
  });

  it("skips hooks with no commands configured", async () => {
    await mkdir(join(gitDir, "hooks"), { recursive: true });

    const config: HooksConfig = {
      "pre-commit": [],
      "pre-push": ["npm run build"],
    };
    await installHooks({ "pre-push": ["npm run build"] }, gitDir);

    const results = await checkHooks(config);

    // Only pre-push should be checked (pre-commit has empty commands)
    assert.equal(results.length, 1);
    assert.equal(results[0].hookName, "pre-push");
  });
});
