import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_DIRS,
  ENV_EXAMPLE_CARVE_OUT,
  KIT_DENY_RULES,
  describeStrictResult,
  installStrictSettings,
  mergeDenyRules,
} from "./agent-config-strict.js";
import { installEnvWriteGate, installInstallGate } from "./agent-config.js";

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-strict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

function settingsOf(dir: string) {
  return JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
}

describe("installStrictSettings", () => {
  it("writes the credential, .env and git deny rules, idempotently", async (t) => {
    const dir = project(t);
    const r1 = await installStrictSettings(dir, "linux");
    assert.equal(r1.action, "created");
    const deny: string[] = settingsOf(dir).permissions.deny;
    for (const rule of [
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.gnupg/**)",
      "Read(~/.config/gcloud/**)",
      "Read(.env)",
      "Read(.env.*)",
      "Bash(git push *--force*)",
      "Bash(git reset *--hard*)",
    ]) {
      assert.ok(deny.includes(rule), rule);
    }
    // A `!` carve-out only reaches rules listed before it.
    assert.ok(deny.indexOf(ENV_EXAMPLE_CARVE_OUT) > deny.indexOf("Read(.env.*)"));
    const r2 = await installStrictSettings(dir, "linux");
    assert.equal(r2.action, "unchanged");
    assert.deepEqual(settingsOf(dir).permissions.deny, deny, "no duplicates on re-run");
  });

  it("keeps the user's own deny rules, allow rules and other keys", async (t) => {
    const dir = project(t);
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        model: "x",
        permissions: { allow: ["Bash(npm test)"], deny: ["Bash(curl *)", "Read(~/.ssh/**)"] },
        sandbox: { filesystem: { denyRead: ["~/.kube"] } },
      }),
    );
    const r = await installStrictSettings(dir, "linux");
    assert.equal(r.action, "updated");
    const s = settingsOf(dir);
    assert.equal(s.model, "x");
    assert.deepEqual(s.permissions.allow, ["Bash(npm test)"]);
    assert.deepEqual(s.permissions.deny.slice(0, 2), ["Bash(curl *)", "Read(~/.ssh/**)"]);
    assert.equal(s.permissions.deny.length, KIT_DENY_RULES.length + 1);
    assert.deepEqual(s.sandbox.filesystem.denyRead, ["~/.kube", ...CREDENTIAL_DIRS]);
  });

  it("enables the sandbox with credential read denies off Windows", async (t) => {
    const dir = project(t);
    const r = await installStrictSettings(dir, "darwin");
    assert.equal(r.sandbox, "enabled");
    const s = settingsOf(dir);
    assert.equal(s.sandbox.enabled, true);
    assert.deepEqual(s.sandbox.filesystem.denyRead, CREDENTIAL_DIRS);
  });

  it("leaves an explicit sandbox.enabled: false as the user set it", async (t) => {
    const dir = project(t);
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ sandbox: { enabled: false } }),
    );
    const r = await installStrictSettings(dir, "linux");
    assert.equal(r.sandbox, "user-disabled");
    assert.equal(settingsOf(dir).sandbox.enabled, false);
    assert.ok(describeStrictResult(r).some((l) => l.includes("left as set")));
  });

  it("writes no sandbox block on native Windows and says so", async (t) => {
    const dir = project(t);
    const r = await installStrictSettings(dir, "win32");
    assert.equal(r.sandbox, "skipped-win32");
    const s = settingsOf(dir);
    assert.equal(s.sandbox, undefined);
    assert.equal(s.permissions.deny.length, KIT_DENY_RULES.length);
    assert.ok(describeStrictResult(r).some((l) => l.includes("native Windows")));
  });
});

describe("mergeDenyRules", () => {
  it("moves a user's .env.example carve-out after the .env rules it must follow", () => {
    const deny = [ENV_EXAMPLE_CARVE_OUT, "Read(.env)"];
    const { moved } = mergeDenyRules(deny);
    assert.equal(moved, true);
    assert.equal(deny.filter((r) => r === ENV_EXAMPLE_CARVE_OUT).length, 1);
    assert.ok(deny.indexOf(ENV_EXAMPLE_CARVE_OUT) > deny.indexOf("Read(.env.*)"));
    assert.equal(mergeDenyRules(deny).moved, false);
  });
});

describe("gate hooks fail closed", () => {
  it("writes onFailure: block on the gate-bash and gate-env hooks", async (t) => {
    const dir = project(t);
    await installInstallGate(dir);
    await installEnvWriteGate(dir);
    const hooks = settingsOf(dir).hooks.PreToolUse.flatMap(
      (g: { hooks: { onFailure?: string }[] }) => g.hooks,
    );
    assert.equal(hooks.length, 2);
    for (const h of hooks) assert.equal(h.onFailure, "block");
  });

  it("adds onFailure: block to a gate wired before it existed, keeping the rest", async (t) => {
    const dir = project(t);
    await installInstallGate(dir);
    const s = settingsOf(dir);
    delete s.hooks.PreToolUse[0].hooks[0].onFailure;
    s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "echo me" }] });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(s));
    const r = await installInstallGate(dir);
    assert.equal(r.action, "updated");
    const after = settingsOf(dir).hooks.PreToolUse;
    assert.equal(after[0].hooks[0].onFailure, "block");
    assert.deepEqual(after[1].hooks[0], { type: "command", command: "echo me" });
    assert.equal((await installInstallGate(dir)).action, "unchanged");
  });
});
