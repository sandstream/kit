import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readSkillsLock,
  writeSkillsLock,
  readCliLock,
  writeCliLock,
  readkitMeta,
  writekitMeta,
  updateSkillsLock,
  updateCliLock,
  checkLockStatus,
} from "./lock.js";

let tempDir: string;
let originalCwd: string;

before(async () => {
  originalCwd = process.cwd();
  tempDir = await mkdtemp(join(tmpdir(), "kit-lock-"));
  process.chdir(tempDir);
});

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

describe("readSkillsLock / writeSkillsLock", () => {
  afterEach(async () => {
    const { rm: rmFs } = await import("node:fs/promises");
    await rmFs(join(tempDir, ".kit"), { recursive: true, force: true });
  });

  it("returns null when skills-lock.json does not exist", async () => {
    const lock = await readSkillsLock();
    assert.equal(lock, null);
  });

  it("round-trips skills lock through write and read", async () => {
    const lock = {
      version: 1,
      skills: {
        "my-skill": {
          source: "my-skill@1.0.0",
          sourceType: "clawhub" as const,
          computedHash: "abc123",
          installedAt: "2026-01-01T00:00:00Z",
        },
      },
    };

    await writeSkillsLock(lock);
    const read = await readSkillsLock();

    assert.ok(read !== null);
    assert.equal(read.version, 1);
    assert.ok(read.skills["my-skill"]);
    assert.equal(read.skills["my-skill"].source, "my-skill@1.0.0");
    assert.equal(read.skills["my-skill"].sourceType, "clawhub");
  });

  it("returns null for corrupted skills-lock.json", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(tempDir, ".kit"), { recursive: true });
    await writeFile(join(tempDir, ".kit", "skills-lock.json"), "{bad json}", "utf-8");

    const lock = await readSkillsLock();
    assert.equal(lock, null);
  });
});

describe("readCliLock / writeCliLock", () => {
  afterEach(async () => {
    const { rm: rmFs } = await import("node:fs/promises");
    await rmFs(join(tempDir, ".kit"), { recursive: true, force: true });
  });

  it("returns null when cli-lock.json does not exist", async () => {
    const lock = await readCliLock();
    assert.equal(lock, null);
  });

  it("round-trips CLI lock through write and read", async () => {
    const lock = {
      version: 1,
      tools: {
        node: {
          version: "22.0.0",
          source: "mise" as const,
          installedAt: "2026-01-01T00:00:00Z",
        },
      },
    };

    await writeCliLock(lock);
    const read = await readCliLock();

    assert.ok(read !== null);
    assert.equal(read.version, 1);
    assert.equal(read.tools.node.version, "22.0.0");
    assert.equal(read.tools.node.source, "mise");
  });
});

describe("readkitMeta / writekitMeta", () => {
  afterEach(async () => {
    const { rm: rmFs } = await import("node:fs/promises");
    await rmFs(join(tempDir, ".kit"), { recursive: true, force: true });
  });

  it("returns null when kit.json does not exist", async () => {
    const meta = await readkitMeta();
    assert.equal(meta, null);
  });

  it("round-trips kit meta through write and read", async () => {
    await writekitMeta({ name: "sandstream/standard", version: "1.2.0" });
    const meta = await readkitMeta();

    assert.ok(meta !== null);
    assert.equal(meta.name, "sandstream/standard");
    assert.equal(meta.version, "1.2.0");
  });
});

describe("updateSkillsLock", () => {
  afterEach(async () => {
    const { rm: rmFs } = await import("node:fs/promises");
    await rmFs(join(tempDir, ".kit"), { recursive: true, force: true });
  });

  it("creates a new lock with clawhub source for semver versions", async () => {
    await updateSkillsLock({ "my-skill": "^1.0.0" });
    const lock = await readSkillsLock();

    assert.ok(lock !== null);
    assert.ok(lock.skills["my-skill"]);
    assert.equal(lock.skills["my-skill"].sourceType, "clawhub");
    assert.ok(lock.skills["my-skill"].source.includes("my-skill"));
  });

  it("parses github:owner/repo format as github source", async () => {
    await updateSkillsLock({ "cool-skill": "github:owner/cool-skill@v2.0" });
    const lock = await readSkillsLock();

    assert.ok(lock !== null);
    assert.equal(lock.skills["cool-skill"].sourceType, "github");
    assert.equal(lock.skills["cool-skill"].auth, "github");
  });

  it("parses ./local/path format as local source", async () => {
    await updateSkillsLock({ "local-skill": "./local/skills/my-skill" });
    const lock = await readSkillsLock();

    assert.ok(lock !== null);
    assert.equal(lock.skills["local-skill"].sourceType, "local");
    assert.equal(lock.skills["local-skill"].source, "./local/skills/my-skill");
  });

  it("parses org/repo format as github source", async () => {
    await updateSkillsLock({ "gh-skill": "get-convex/agent-skills" });
    const lock = await readSkillsLock();

    assert.ok(lock !== null);
    assert.equal(lock.skills["gh-skill"].sourceType, "github");
  });

  it("preserves existing entries when updating", async () => {
    await updateSkillsLock({ "skill-a": "1.0.0" });
    await updateSkillsLock({ "skill-b": "2.0.0" });
    const lock = await readSkillsLock();

    assert.ok(lock !== null);
    assert.ok(lock.skills["skill-a"], "skill-a should be preserved");
    assert.ok(lock.skills["skill-b"], "skill-b should be added");
  });

  it("sets kit metadata when provided", async () => {
    await updateSkillsLock({ "skill-a": "1.0.0" }, "sandstream/standard");
    const lock = await readSkillsLock();

    assert.ok(lock !== null);
    assert.equal(lock.kit, "sandstream/standard");
  });
});

describe("updateCliLock", () => {
  afterEach(async () => {
    const { rm: rmFs } = await import("node:fs/promises");
    await rmFs(join(tempDir, ".kit"), { recursive: true, force: true });
  });

  it("creates a new CLI lock with tool entries", async () => {
    await updateCliLock({
      node: { version: "22.0.0", source: "mise" },
      bun: { version: "1.2.0", source: "npm" },
    });
    const lock = await readCliLock();

    assert.ok(lock !== null);
    assert.equal(lock.tools.node.version, "22.0.0");
    assert.equal(lock.tools.node.source, "mise");
    assert.equal(lock.tools.bun.version, "1.2.0");
  });

  it("preserves existing tool entries when updating", async () => {
    await updateCliLock({ node: { version: "22.0.0", source: "mise" } });
    await updateCliLock({ deno: { version: "2.0.0", source: "mise" } });
    const lock = await readCliLock();

    assert.ok(lock !== null);
    assert.ok(lock.tools.node, "node should be preserved");
    assert.ok(lock.tools.deno, "deno should be added");
  });

  it("stores auth field when provided", async () => {
    await updateCliLock({
      "private-tool": { version: "1.0.0", source: "npm", auth: "npm-token" },
    });
    const lock = await readCliLock();

    assert.ok(lock !== null);
    assert.equal(lock.tools["private-tool"].auth, "npm-token");
  });
});

describe("checkLockStatus", () => {
  afterEach(async () => {
    const { rm: rmFs } = await import("node:fs/promises");
    await rmFs(join(tempDir, ".kit"), { recursive: true, force: true });
  });

  it("reports out-of-sync when lock files are missing", async () => {
    const status = await checkLockStatus({ "skill-a": "1.0.0" }, { node: "22" });

    assert.equal(status.skillsLockExists, false);
    assert.equal(status.cliLockExists, false);
    assert.equal(status.skillsInSync, false);
    assert.equal(status.cliInSync, false);
    assert.deepEqual(status.missingSkills, ["skill-a"]);
    assert.deepEqual(status.missingTools, ["node"]);
  });

  it("reports in-sync when lock files contain all configured items", async () => {
    await updateSkillsLock({ "skill-a": "1.0.0" });
    await updateCliLock({ node: { version: "22.0.0", source: "mise" } });

    const status = await checkLockStatus({ "skill-a": "1.0.0" }, { node: "22" });

    assert.equal(status.skillsLockExists, true);
    assert.equal(status.cliLockExists, true);
    assert.equal(status.skillsInSync, true);
    assert.equal(status.cliInSync, true);
    assert.deepEqual(status.missingSkills, []);
    assert.deepEqual(status.missingTools, []);
  });

  it("identifies missing skills when only some are in the lock", async () => {
    await updateSkillsLock({ "skill-a": "1.0.0" });

    const status = await checkLockStatus({ "skill-a": "1.0.0", "skill-b": "2.0.0" }, {});

    assert.equal(status.skillsInSync, false);
    assert.deepEqual(status.missingSkills, ["skill-b"]);
  });

  it("reports out-of-sync when lock files are absent even with empty config", async () => {
    // Lock files don't exist → inSync is false regardless of config size
    const status = await checkLockStatus({}, {});

    assert.equal(status.skillsLockExists, false);
    assert.equal(status.cliLockExists, false);
    assert.equal(status.skillsInSync, false);
    assert.equal(status.cliInSync, false);
    assert.deepEqual(status.missingSkills, []);
    assert.deepEqual(status.missingTools, []);
  });
});
