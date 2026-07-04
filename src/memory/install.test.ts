import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installMemoryHooks,
  uninstallMemoryHooks,
  installStatusline,
  uninstallStatusline,
  memoryHooksLiveness,
} from "./install.js";

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
    const upsHook = ups.find((c: string) => c.endsWith("memory hook user-prompt-submit"));
    assert.ok(upsHook, "wires the user-prompt-submit hook");
    // Must be an ABSOLUTE invocation (node + cli.js or the ~/.kit/bin wrapper),
    // not a bare `kit` that the hook shell's PATH can't resolve. The path carries
    // a separator — "/" on POSIX, "\\" on Windows — so accept either. #43.
    assert.ok(/[/\\]/.test(upsHook), `hook command must be absolute, got: ${upsHook}`);
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

  it("recognizes a legacy bare-`kit` hook and neither duplicates nor leaves it on uninstall", () => {
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
    // Re-install must treat the legacy entry as already present (no duplicate).
    const res = installMemoryHooks();
    assert.ok(!res.added.includes("UserPromptSubmit"), "must not add a second UPS hook");
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const ours = s.hooks.UserPromptSubmit.filter((g: { hooks: { command: string }[] }) =>
      g.hooks.some((h) => h.command.endsWith("memory hook user-prompt-submit")),
    );
    assert.equal(ours.length, 1, "no duplicate UPS hook");
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
