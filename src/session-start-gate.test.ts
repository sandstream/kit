import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSessionStartCheck, upsertSessionStartCheck } from "./session-start-gate.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CMD = "kit hooks context";

describe("upsertSessionStartCheck", () => {
  it("adds once, then reports unchanged, and keeps other hooks", () => {
    const settings = {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other" }] }] },
      model: "x",
    };
    assert.equal(upsertSessionStartCheck(settings, CMD), "added");
    assert.equal(upsertSessionStartCheck(settings, CMD), "unchanged");
    const commands = settings.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    assert.deepEqual(commands, ["other", CMD]);
    assert.equal(settings.model, "x");
  });

  it("refreshes an entry whose invocation moved", () => {
    const settings = {
      hooks: { SessionStart: [{ hooks: [{ command: "/old/kit " + CMD.slice(4) }] }] },
    };
    assert.equal(upsertSessionStartCheck(settings, CMD), "updated");
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, CMD);
  });
});

describe("installSessionStartCheck", () => {
  it("writes .claude/settings.json in a Claude Code project and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-session-start-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# x\n");
      assert.equal((await installSessionStartCheck(dir, CMD)).action, "created");
      assert.equal((await installSessionStartCheck(dir, CMD)).action, "unchanged");
      const saved = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
      assert.equal(saved.hooks.SessionStart[0].hooks[0].command, CMD);
    } finally {
      rmTemp(dir);
    }
  });

  it("skips a non-Claude project and never overwrites an unparseable settings file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-session-start-bad-"));
    try {
      assert.equal((await installSessionStartCheck(dir, CMD)).action, "skipped");
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, ".claude", "settings.json"), "{ not json");
      assert.equal((await installSessionStartCheck(dir, CMD)).action, "failed");
      assert.equal(readFileSync(join(dir, ".claude", "settings.json"), "utf8"), "{ not json");
    } finally {
      rmTemp(dir);
    }
  });
});
