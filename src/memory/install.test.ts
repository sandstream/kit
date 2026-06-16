import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMemoryHooks, uninstallMemoryHooks } from "./install.js";

describe("memory hook installer", () => {
  let tmp: string;
  let settingsPath: string;
  const prev = process.env.KIT_CLAUDE_SETTINGS;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-install-"));
    settingsPath = join(tmp, "settings.json");
    process.env.KIT_CLAUDE_SETTINGS = settingsPath;
  });

  beforeEach(() => {
    // Start each test from a settings file with an unrelated, pre-existing hook.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "some-other-tool" }] }],
        },
      }),
    );
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_CLAUDE_SETTINGS;
    else process.env.KIT_CLAUDE_SETTINGS = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("installs all hooks without clobbering existing ones", () => {
    const res = installMemoryHooks();
    assert.deepEqual(res.added.sort(), ["SessionEnd", "SessionStart", "UserPromptSubmit"]);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const ups = s.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command),
    );
    assert.ok(ups.includes("some-other-tool"), "preserves the pre-existing hook");
    assert.ok(ups.includes("kit memory hook user-prompt-submit"));
    assert.ok(
      s.hooks.SessionEnd.some((g: { hooks: { command: string }[] }) =>
        g.hooks.some((h) => h.command === "kit memory hook session-end"),
      ),
    );
    assert.ok(
      s.hooks.SessionStart.some((g: { hooks: { command: string }[] }) =>
        g.hooks.some((h) => h.command === "kit memory hook session-start"),
      ),
    );
  });

  it("is idempotent — re-install adds nothing and creates no duplicates", () => {
    installMemoryHooks();
    const res2 = installMemoryHooks();
    assert.deepEqual(res2.added, []);
    assert.deepEqual(res2.alreadyPresent.sort(), ["SessionEnd", "SessionStart", "UserPromptSubmit"]);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const ours = s.hooks.UserPromptSubmit.filter((g: { hooks: { command: string }[] }) =>
      g.hooks.some((h) => h.command === "kit memory hook user-prompt-submit"),
    );
    assert.equal(ours.length, 1);
  });

  it("uninstall removes only our hooks, leaving others intact", () => {
    installMemoryHooks();
    const res = uninstallMemoryHooks();
    assert.deepEqual(res.removed.sort(), ["SessionEnd", "SessionStart", "UserPromptSubmit"]);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const ups = s.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command),
    );
    assert.ok(ups.includes("some-other-tool"), "unrelated hook survives uninstall");
    assert.ok(!ups.includes("kit memory hook user-prompt-submit"));
  });
});
