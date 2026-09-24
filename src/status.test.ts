import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherStatus } from "./status.js";
import { openMemoryDb, insertMessage } from "./memory/db.js";
import { CONFIG_SCHEMA_VERSION } from "./config.js";
import { KIT_BLOCK_BEGIN } from "./agent-config.js";

let tmp: string;
const statusEnvKeys = [
  "KIT_MEMORY_DB",
  "KIT_CLAUDE_SETTINGS",
  "KIT_MEMORY_HOOK_MARKER",
  "KIT_CODEX_HOOKS",
  "KIT_CODEX_MEMORY_HOOK_MARKER",
] as const;
const previousEnv = statusEnvKeys.map((key) => [key, process.env[key]] as const);

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "kit-status-"));
});

after(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const find = (items: Awaited<ReturnType<typeof gatherStatus>>, key: string) =>
  items.find((i) => i.key === key);

describe("kit status without full setup", () => {
  it("empty project: signals off with actionable hints", async () => {
    const proj = join(tmp, "empty");
    mkdirSync(proj, { recursive: true });
    process.env.KIT_MEMORY_DB = join(proj, "memory.db"); // fresh store, no messages
    process.env.KIT_CLAUDE_SETTINGS = join(proj, "absent.json"); // not installed
    process.env.KIT_MEMORY_HOOK_MARKER = join(proj, "absent-claude-marker");
    process.env.KIT_CODEX_HOOKS = join(proj, "absent-codex-hooks.json");
    process.env.KIT_CODEX_MEMORY_HOOK_MARKER = join(proj, "absent-codex-marker");

    const items = await gatherStatus(proj);

    assert.equal(find(items, "config")?.ok, false);
    assert.match(find(items, "config")?.hint ?? "", /kit init/);
    // No .kit.toml → the config-derived checks are skipped entirely.
    assert.equal(find(items, "vault"), undefined);
    assert.equal(find(items, "tools"), undefined);
    // Project-level checks still run without a config.
    assert.equal(find(items, "gitignore")?.ok, false);
    assert.match(find(items, "gitignore")?.detail ?? "", /Git.*could not be verified/);
    assert.equal(find(items, "dep-policy")?.ok, false);
    assert.match(find(items, "dep-policy")?.hint ?? "", /security policy init/);
    assert.equal(find(items, "agent-config")?.ok, false);
    assert.equal(find(items, "memory")?.ok, false);
    assert.equal(find(items, "memory-hooks")?.ok, false);
    const gitHooks = find(items, "git-hooks");
    assert.ok(gitHooks);
    assert.equal(gitHooks.ok, false);
  });

  it("reports configured git-hook enforcement separately from memory hooks", async () => {
    const proj = join(tmp, "git-hooks");
    mkdirSync(proj, { recursive: true });
    execFileSync("git", ["init", "-q", proj]);
    writeFileSync(join(proj, ".kit.toml"), '[hooks]\npre-commit = ["npm test"]\n');
    writeFileSync(join(proj, ".git", "hooks", "pre-commit"), "#!/bin/sh\nnpm test\n", {
      mode: 0o755,
    });
    const items = await gatherStatus(proj);
    assert.equal(find(items, "git-hooks")?.ok, true);
    assert.match(find(items, "git-hooks")?.detail ?? "", /1.*wired/);
  });
});

describe("kit status with memory hooks", () => {
  it("configured project: every signal on", async () => {
    const proj = join(tmp, "ready");
    mkdirSync(proj, { recursive: true });
    execFileSync("git", ["init", "-q", proj]);
    writeFileSync(
      join(proj, ".kit.toml"),
      // The version stamp is part of being configured: the new `config schema` row reports a
      // config that predates the current schema, and this fixture is meant to be a repo with
      // nothing outstanding. Written from the constant so the fixture cannot rot behind it.
      `version = ${CONFIG_SCHEMA_VERSION}\n\n[tools]\nnode = "22"\n\n[secrets]\nstore = "1password"\n\n[hooks]\npre-commit = ["npm test"]\n`,
    );
    writeFileSync(join(proj, ".git", "hooks", "pre-commit"), "#!/bin/sh\nnpm test\n", {
      mode: 0o755,
    });
    writeFileSync(join(proj, "CLAUDE.md"), `# Project\n\n${KIT_BLOCK_BEGIN}\nuse kit\n`);
    writeFileSync(
      join(proj, ".gitignore"),
      [
        ".env*",
        "node_modules",
        ".kit/*",
        "!.kit/shared/",
        ".kit-audit.jsonl",
        ".kit-audit.pending",
        ".kit-skipped-commits.jsonl",
        "*.prod-backup",
        "*.pem",
        "*.key",
        "id_rsa*",
        "id_ed25519*",
        "*.p12",
        "*-service-account*.json",
        "",
      ].join("\n"),
    );
    writeFileSync(join(proj, ".kit-allowlist.json"), "{}");

    const dbPath = join(proj, "memory.db");
    const seed = openMemoryDb(dbPath);
    insertMessage(seed, {
      uuid: "u1",
      sessionId: "s1",
      type: "user",
      role: "user",
      content: "hello",
    });
    seed.close();
    process.env.KIT_MEMORY_DB = dbPath;

    const settings = join(proj, "settings.json");
    const hook = (sub: string) => ({
      hooks: [{ type: "command", command: `kit memory hook ${sub}` }],
    });
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [hook("user-prompt-submit")],
          SessionEnd: [hook("session-end")],
          SessionStart: [hook("session-start")],
        },
      }),
    );
    process.env.KIT_CLAUDE_SETTINGS = settings;
    process.env.KIT_MEMORY_HOOK_MARKER = join(proj, "claude-marker");
    writeFileSync(process.env.KIT_MEMORY_HOOK_MARKER, "installed\n");
    process.env.KIT_CODEX_HOOKS = join(proj, "absent-codex-hooks.json");
    process.env.KIT_CODEX_MEMORY_HOOK_MARKER = join(proj, "absent-codex-marker");

    const items = await gatherStatus(proj);

    assert.equal(find(items, "config")?.ok, true);
    assert.equal(find(items, "vault")?.ok, true);
    assert.equal(find(items, "tools")?.ok, true);
    assert.equal(find(items, "gitignore")?.ok, true);
    assert.equal(find(items, "dep-policy")?.ok, true);
    assert.equal(find(items, "agent-config")?.ok, true);
    assert.equal(find(items, "memory")?.ok, true);
    assert.equal(find(items, "memory-hooks")?.ok, true);
    // every signal green → the summary reflects a fully-configured project
    assert.ok(items.every((i) => i.ok));
  });

  it("reports Codex-only memory hooks through canonical liveness", async () => {
    const proj = join(tmp, "codex-only");
    mkdirSync(proj, { recursive: true });
    process.env.KIT_MEMORY_DB = join(proj, "memory.db");
    process.env.KIT_CLAUDE_SETTINGS = join(proj, "absent-claude.json");
    process.env.KIT_MEMORY_HOOK_MARKER = join(proj, "absent-claude-marker");
    process.env.KIT_CODEX_HOOKS = join(proj, "hooks.json");
    process.env.KIT_CODEX_MEMORY_HOOK_MARKER = join(proj, "codex-marker");
    writeFileSync(process.env.KIT_CODEX_MEMORY_HOOK_MARKER, "installed\n");
    const hook = (sub: string) => ({
      hooks: [{ type: "command", command: `kit memory hook ${sub}` }],
    });
    writeFileSync(
      process.env.KIT_CODEX_HOOKS,
      JSON.stringify({
        hooks: {
          SessionEnd: [hook("session-end-codex")],
          SessionStart: [hook("session-start")],
        },
      }),
    );

    const items = await gatherStatus(proj);
    assert.equal(find(items, "memory-hooks")?.ok, true);
    assert.match(find(items, "memory-hooks")?.detail ?? "", /2 wired/);
  });
});
