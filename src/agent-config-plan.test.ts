import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

/** Another tool's PreToolUse hook, which agent-config must keep first and unchanged. */
const OTHER_HOOK = { type: "command", command: "other-tool check-bash" };
const FIXTURE =
  JSON.stringify(
    { model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [OTHER_HOOK] }] } },
    null,
    2,
  ) + "\n";

/** A git project with `.claude/settings.json` (untracked) and an isolated home directory. */
function project(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-agent-config-plan-"));
  t.after(() => rmTemp(dir));
  const root = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(home, { recursive: true });
  spawnSync("git", ["init", "-q", root]);
  const settings = join(root, ".claude", "settings.json");
  writeFileSync(settings, FIXTURE);
  const kit = (args: string[]) =>
    spawnSync(process.execPath, [CLI, "agent-config", ...args], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        KIT_HIDE_HOOK_SKIP_BANNER: "1",
        KIT_AUDIT_ANCHOR: "0",
        KIT_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
      timeout: 60_000,
    });
  return { root, home, settings, kit };
}

function planHash(stdout: string): string {
  const lines = stdout.trimEnd().split("\n");
  const match = /^plan hash: ([0-9a-f]{64})$/.exec(lines[lines.length - 1] ?? "");
  assert.ok(match, `the last line is the plan hash:\n${stdout}`);
  return match[1];
}

/** The commands of the PreToolUse hooks, in order. */
function preToolUseCommands(path: string): string[] {
  const doc = JSON.parse(readFileSync(path, "utf-8")) as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };
  return doc.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
}

describe("kit agent-config --plan", () => {
  it("prints a diff, both invariants and a hash, and writes nothing", (t) => {
    const { root, home, settings, kit } = project(t);
    const r = kit(["--plan"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^--- a\/\.claude\/settings\.json$/m);
    assert.match(r.stdout, /^\+\+\+ b\/\.claude\/settings\.json$/m);
    assert.match(r.stdout, /^\+.*gate-bash/m, "the diff adds the install gate");
    assert.match(r.stdout, /^ +"command": "other-tool check-bash"$/m, "the other hook is context");
    assert.match(r.stdout, /invariant 1 holds: nothing outside "hooks" changes/);
    assert.match(r.stdout, /invariant 2 holds: 1 hook entry/);
    planHash(r.stdout);
    assert.equal(readFileSync(settings, "utf-8"), FIXTURE, "settings.json is byte-identical");
    assert.deepEqual(
      readdirSync(join(root, ".claude")),
      ["settings.json"],
      "no marker, no local file",
    );
    assert.equal(existsSync(join(root, "CLAUDE.md")), false, "no rules file");
    assert.equal(existsSync(join(root, "AGENTS.md")), false, "no rules file");
    assert.equal(existsSync(join(home, ".kit", "bin", "kit")), false, "no wrapper");
  });

  it("--apply with the plan's hash writes it and keeps the other hook first", (t) => {
    const { settings, kit } = project(t);
    const hash = planHash(kit(["--plan"]).stdout);
    const r = kit(["--apply", hash]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const commands = preToolUseCommands(settings);
    assert.equal(commands[0], OTHER_HOOK.command, "the other tool's hook is still first");
    assert.ok(
      commands.slice(1).some((cmd) => cmd.includes("gate-bash")),
      commands.join("\n"),
    );
    assert.equal((JSON.parse(readFileSync(settings, "utf-8")) as { model: string }).model, "opus");
    // The applied file is the planned file: a new plan finds nothing left to change.
    const again = kit(["--plan"]);
    assert.match(again.stdout, /no changes/);
  });

  it("--apply with a stale hash exits non-zero and writes nothing", (t) => {
    const { root, home, settings, kit } = project(t);
    const hash = planHash(kit(["--plan"]).stdout);
    const changed = FIXTURE.replace('"model": "opus"', '"model": "sonnet"');
    writeFileSync(settings, changed);
    const r = kit(["--apply", hash]);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(
      r.stdout + r.stderr,
      /the settings changed since the plan; run kit agent-config --plan again/,
    );
    assert.equal(readFileSync(settings, "utf-8"), changed, "settings.json is untouched");
    assert.deepEqual(readdirSync(join(root, ".claude")), ["settings.json"]);
    assert.equal(existsSync(join(root, "CLAUDE.md")), false);
    assert.equal(existsSync(join(home, ".kit", "bin", "kit")), false);
  });
});
