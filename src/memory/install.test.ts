import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installMemoryHooks,
  installCodexMemoryHooks,
  uninstallMemoryHooks,
  uninstallCodexMemoryHooks,
  installStatusline,
  uninstallStatusline,
  memoryHooksLiveness,
  codexMemoryHooksLiveness,
} from "./install.js";

describe("memory hook installer", () => {
  let tmp: string;
  let settingsPath: string;
  const prev = process.env.KIT_CLAUDE_SETTINGS;
  const prevMarker = process.env.KIT_MEMORY_HOOK_MARKER;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-install-"));
    settingsPath = join(tmp, "settings.json");
    process.env.KIT_CLAUDE_SETTINGS = settingsPath;
    process.env.KIT_MEMORY_HOOK_MARKER = join(tmp, "marker");
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
    if (prevMarker === undefined) delete process.env.KIT_MEMORY_HOOK_MARKER;
    else process.env.KIT_MEMORY_HOOK_MARKER = prevMarker;
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
    const upsHook = ups.find((c: string) => c.endsWith("memory hook user-prompt-submit"));
    assert.ok(upsHook, "wires the user-prompt-submit hook");
    // Must not be a bare `kit` that the hook shell's PATH can't resolve. When the
    // wrapper exists, shared hook config uses "$HOME/.kit/bin/kit"; otherwise it
    // falls back to node + cli.js.
    assert.ok(!upsHook.startsWith("kit "), `hook command must not be bare kit: ${upsHook}`);
    assert.ok(
      s.hooks.SessionEnd.some((g: { hooks: { command: string }[] }) =>
        g.hooks.some((h) => h.command.endsWith("memory hook session-end")),
      ),
    );
    assert.ok(
      s.hooks.SessionStart.some((g: { hooks: { command: string }[] }) =>
        g.hooks.some((h) => h.command.endsWith("memory hook session-start")),
      ),
    );
  });

  it("is idempotent — re-install adds nothing and creates no duplicates", () => {
    installMemoryHooks();
    const res2 = installMemoryHooks();
    assert.deepEqual(res2.added, []);
    assert.deepEqual(res2.alreadyPresent.sort(), [
      "SessionEnd",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const ours = s.hooks.UserPromptSubmit.filter((g: { hooks: { command: string }[] }) =>
      g.hooks.some((h) => h.command.endsWith("memory hook user-prompt-submit")),
    );
    assert.equal(ours.length, 1);
  });

  it("upgrades a legacy bare-`kit` hook and neither duplicates nor leaves it on uninstall", () => {
    // Simulate a settings file written by an older kit (bare command).
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "kit memory hook user-prompt-submit" }] },
          ],
        },
      }),
    );
    // Re-install must refresh the legacy entry in-place (no duplicate).
    const res = installMemoryHooks();
    assert.ok(!res.added.includes("UserPromptSubmit"), "must not add a second UPS hook");
    assert.ok(res.updated.includes("UserPromptSubmit"), "must update the legacy UPS hook");
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const ours = s.hooks.UserPromptSubmit.filter((g: { hooks: { command: string }[] }) =>
      g.hooks.some((h) => h.command.endsWith("memory hook user-prompt-submit")),
    );
    assert.equal(ours.length, 1, "no duplicate UPS hook");
    assert.notEqual(ours[0].hooks[0].command, "kit memory hook user-prompt-submit");
    assert.ok(
      !ours[0].hooks[0].command.startsWith("kit "),
      "legacy hook rewritten away from bare kit",
    );
    // Uninstall removes the legacy bare entry too (suffix match).
    uninstallMemoryHooks();
    const s2 = JSON.parse(readFileSync(settingsPath, "utf8"));
    const left = (s2.hooks.UserPromptSubmit ?? []).filter((g: { hooks: { command: string }[] }) =>
      g.hooks?.some((h) => h.command.endsWith("memory hook user-prompt-submit")),
    );
    assert.equal(left.length, 0, "legacy hook removed");
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

describe("Codex memory hook installer", () => {
  let tmp: string;
  let hooksPath: string;
  const prevHooks = process.env.KIT_CODEX_HOOKS;
  const prevMarker = process.env.KIT_CODEX_MEMORY_HOOK_MARKER;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-codex-install-"));
    hooksPath = join(tmp, "hooks.json");
    process.env.KIT_CODEX_HOOKS = hooksPath;
    process.env.KIT_CODEX_MEMORY_HOOK_MARKER = join(tmp, "marker");
  });

  beforeEach(() => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        description: "user-owned hooks",
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "some-other-tool" }] }],
        },
      }),
    );
  });

  after(() => {
    if (prevHooks === undefined) delete process.env.KIT_CODEX_HOOKS;
    else process.env.KIT_CODEX_HOOKS = prevHooks;
    if (prevMarker === undefined) delete process.env.KIT_CODEX_MEMORY_HOOK_MARKER;
    else process.env.KIT_CODEX_MEMORY_HOOK_MARKER = prevMarker;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("merges silent Codex lifecycle hooks and gives SessionEnd its supported timeout", () => {
    const result = installCodexMemoryHooks();
    assert.deepEqual(result.added.sort(), ["SessionEnd", "SessionStart"]);

    const config = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.equal(existsSync(`${hooksPath}.bak`), true, "existing Codex config is backed up");
    assert.equal(config.description, "user-owned hooks", "top-level metadata survives");
    assert.ok(
      config.hooks.SessionStart.some((group: { hooks: { command: string }[] }) =>
        group.hooks.some((hook) => hook.command === "some-other-tool"),
      ),
      "unrelated hook survives",
    );
    const sessionEnd = config.hooks.SessionEnd[0].hooks[0];
    assert.ok(sessionEnd.command.endsWith("memory hook session-end-codex"));
    assert.equal(sessionEnd.timeout, 3);
  });

  it("is idempotent and uninstall removes only kit hooks", () => {
    installCodexMemoryHooks();
    const second = installCodexMemoryHooks();
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.updated, []);
    assert.equal(second.alreadyPresent.length, 2);

    const removed = uninstallCodexMemoryHooks();
    assert.deepEqual(removed.removed.sort(), ["SessionEnd", "SessionStart"]);
    const config = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.ok(
      config.hooks.SessionStart.some((group: { hooks: { command: string }[] }) =>
        group.hooks.some((hook) => hook.command === "some-other-tool"),
      ),
    );
  });

  it("removes legacy noisy prompt hooks while preserving hooks in their group", () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command: "some-other-tool" },
                { type: "command", command: "kit memory hook user-prompt-submit" },
              ],
            },
          ],
        },
      }),
    );

    installCodexMemoryHooks();
    const config = JSON.parse(readFileSync(hooksPath, "utf8"));
    const commands = config.hooks.UserPromptSubmit.flatMap(
      (group: { hooks: { command: string }[] }) => group.hooks.map((hook) => hook.command),
    );
    assert.deepEqual(commands, ["some-other-tool"]);
  });

  it("upgrades stale absolute Codex hook paths in-place", () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/root/.kit/bin/kit memory hook session-end-codex",
                },
              ],
            },
          ],
        },
      }),
    );

    const result = installCodexMemoryHooks();
    assert.deepEqual(result.added, ["SessionStart"]);
    assert.deepEqual(result.updated, ["SessionEnd"]);
    const config = JSON.parse(readFileSync(hooksPath, "utf8"));
    const hook = config.hooks.SessionEnd[0].hooks[0];
    assert.notEqual(hook.command, "/root/.kit/bin/kit memory hook session-end-codex");
    assert.ok(!hook.command.includes("/root/.kit/bin/kit"));
    assert.ok(hook.command.endsWith("memory hook session-end-codex"));
    assert.equal(hook.timeout, 3);
  });

  it("removes empty retired prompt-hook events from Codex config", () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "kit memory hook user-prompt-submit" }] },
          ],
        },
      }),
    );

    installCodexMemoryHooks();
    const config = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.equal(config.hooks.UserPromptSubmit, undefined);
  });

  it("cleans up already-empty retired prompt-hook events from Codex config", () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [],
        },
      }),
    );

    installCodexMemoryHooks();
    const config = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.equal(config.hooks.UserPromptSubmit, undefined);
  });

  it("reports Codex liveness from its own durable marker", () => {
    installCodexMemoryHooks();
    assert.deepEqual(codexMemoryHooksLiveness().missing, []);
    writeFileSync(hooksPath, "{}\n");
    assert.deepEqual(codexMemoryHooksLiveness().missing.sort(), ["SessionEnd", "SessionStart"]);
  });

  it("refuses invalid JSON without overwriting it", () => {
    const invalid = "{ definitely not json\n";
    writeFileSync(hooksPath, invalid);
    assert.throws(() => installCodexMemoryHooks(), /refusing to overwrite/);
    assert.equal(readFileSync(hooksPath, "utf8"), invalid);
  });
});

describe("status-line installer", () => {
  let tmp: string;
  let settingsPath: string;
  const prev = process.env.KIT_CLAUDE_SETTINGS;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-sl-"));
    settingsPath = join(tmp, "settings.json");
    process.env.KIT_CLAUDE_SETTINGS = settingsPath;
  });
  after(() => {
    if (prev === undefined) delete process.env.KIT_CLAUDE_SETTINGS;
    else process.env.KIT_CLAUDE_SETTINGS = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("wires kit statusline when absent, idempotently", () => {
    writeFileSync(settingsPath, "{}");
    const r1 = installStatusline();
    assert.equal(r1.status, "added");
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(s.statusLine.type, "command");
    assert.ok(s.statusLine.command.endsWith("statusline"));
    // second run is a no-op
    assert.equal(installStatusline().status, "already");
  });

  it("updates a stale kit statusLine command in-place", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        statusLine: { type: "command", command: "/root/.kit/bin/kit statusline" },
      }),
    );
    const result = installStatusline();
    assert.equal(result.status, "updated");
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.notEqual(s.statusLine.command, "/root/.kit/bin/kit statusline");
    assert.ok(s.statusLine.command.endsWith("statusline"));
  });

  it("never clobbers a user's existing custom statusLine", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: "my-own-prompt" } }),
    );
    assert.equal(installStatusline().status, "foreign");
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(s.statusLine.command, "my-own-prompt", "left as-is");
    // and uninstall must NOT remove a foreign statusLine
    assert.equal(uninstallStatusline().removed, false);
    assert.equal(
      JSON.parse(readFileSync(settingsPath, "utf8")).statusLine.command,
      "my-own-prompt",
    );
  });

  it("uninstall removes only our statusLine", () => {
    writeFileSync(settingsPath, "{}");
    installStatusline();
    assert.equal(uninstallStatusline().removed, true);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).statusLine, undefined);
  });
});

describe("memoryHooksLiveness (R5: silent hook removal is visible)", () => {
  let tmp: string;
  let settings: string;
  let marker: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-liveness-"));
    settings = join(tmp, "settings.json");
    marker = join(tmp, "marker");
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("everInstalled=false when the marker is absent (never installed → no false alarm)", () => {
    writeFileSync(settings, "{}");
    const live = memoryHooksLiveness(settings, join(tmp, "nope"));
    assert.equal(live.everInstalled, false);
  });

  it("all present after a real install", () => {
    // Install into `settings`, marker into `marker`.
    const prevS = process.env.KIT_CLAUDE_SETTINGS;
    const prevM = process.env.KIT_MEMORY_HOOK_MARKER;
    process.env.KIT_CLAUDE_SETTINGS = settings;
    process.env.KIT_MEMORY_HOOK_MARKER = marker;
    try {
      writeFileSync(settings, "{}");
      installMemoryHooks();
      const live = memoryHooksLiveness(settings, marker);
      assert.equal(live.everInstalled, true);
      assert.deepEqual(live.missing, []);
      assert.equal(live.present.length, 3);
    } finally {
      if (prevS === undefined) delete process.env.KIT_CLAUDE_SETTINGS;
      else process.env.KIT_CLAUDE_SETTINGS = prevS;
      if (prevM === undefined) delete process.env.KIT_MEMORY_HOOK_MARKER;
      else process.env.KIT_MEMORY_HOOK_MARKER = prevM;
    }
  });

  it("reports missing hooks when the marker survives but settings were stripped", () => {
    writeFileSync(marker, "installed\n"); // durable marker present
    writeFileSync(settings, "{}"); // ...but hooks removed
    const live = memoryHooksLiveness(settings, marker);
    assert.equal(live.everInstalled, true);
    assert.equal(live.missing.length, 3, "all three hooks flagged missing");
    assert.equal(live.present.length, 0);
  });
});
