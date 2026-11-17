/**
 * `kit agent-config --user` writes the gates into `<home>/.claude/settings.json`. Every test uses
 * its own temporary home, passed in, so the real ~/.claude is never read or written.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeUserGates, installUserGates } from "./agent-config-user.js";
import { userGateCommands, userSettingsPath } from "./gate-liveness-user.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

type Settings = {
  hooks?: { PreToolUse?: { matcher?: string; hooks: { command: string; onFailure?: string }[] }[] };
  [k: string]: unknown;
};

function withHome(fn: (home: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "kit-agent-user-"));
    try {
      await fn(home);
    } finally {
      rmTemp(home);
    }
  };
}

const read = (home: string) =>
  JSON.parse(readFileSync(userSettingsPath(home), "utf-8")) as Settings;

describe("installUserGates", () => {
  it(
    "creates ~/.claude/settings.json with both gates, failing closed",
    withHome(async (home) => {
      const r = await installUserGates(home);
      assert.equal(r.action, "created", r.detail);
      assert.equal(r.backup, undefined, "nothing to back up");
      const pre = read(home).hooks?.PreToolUse ?? [];
      assert.deepEqual(
        pre.map((g) => g.matcher),
        ["Bash", "Write|Edit|NotebookEdit"],
      );
      for (const g of pre) assert.equal(g.hooks[0].onFailure, "block");
      assert.equal(userGateCommands(home).length, 2);
    }),
  );

  it(
    "merges into existing settings without dropping a key, and keeps the file as it was",
    withHome(async (home) => {
      mkdirSync(join(home, ".claude"));
      const original = {
        model: "opus",
        permissions: { allow: ["Bash(ls:*)"] },
        statusLine: { type: "command", command: "echo hi" },
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/mine.sh" }] }],
          Stop: [{ hooks: [{ type: "command", command: "/opt/stop.sh" }] }],
        },
      };
      const text = JSON.stringify(original, null, 2);
      writeFileSync(userSettingsPath(home), text);
      const r = await installUserGates(home);
      assert.equal(r.action, "updated", r.detail);
      const after = read(home);
      assert.equal(after.model, "opus");
      assert.deepEqual(after.permissions, original.permissions);
      assert.deepEqual(after.statusLine, original.statusLine);
      assert.deepEqual(after.hooks?.["Stop" as "PreToolUse"], original.hooks.Stop);
      const commands = (after.hooks?.PreToolUse ?? []).flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      assert.ok(commands.includes("/opt/mine.sh"), "the user's own PreToolUse hook stays");
      assert.equal(userGateCommands(home).length, 2);
      assert.equal(r.backup, `${userSettingsPath(home)}.bak`);
      assert.equal(readFileSync(r.backup, "utf-8"), text);
    }),
  );

  it(
    "is unchanged on a second run",
    withHome(async (home) => {
      await installUserGates(home);
      const first = readFileSync(userSettingsPath(home), "utf-8");
      const r = await installUserGates(home);
      assert.equal(r.action, "unchanged", r.detail);
      assert.equal(readFileSync(userSettingsPath(home), "utf-8"), first);
      assert.equal(userGateCommands(home).length, 2, "no duplicate gate entries");
    }),
  );
});

describe("installUserGates: what it refuses", () => {
  it(
    "refuses a file that is not JSON, and leaves it as it was",
    withHome(async (home) => {
      mkdirSync(join(home, ".claude"));
      writeFileSync(userSettingsPath(home), "{ not json");
      const r = await installUserGates(home);
      assert.equal(r.action, "failed");
      assert.match(r.detail ?? "", /not valid JSON/);
      assert.equal(readFileSync(userSettingsPath(home), "utf-8"), "{ not json");
      assert.equal(existsSync(`${userSettingsPath(home)}.bak`), false);
    }),
  );

  it(
    "refuses a file whose hooks cannot take a PreToolUse entry",
    withHome(async (home) => {
      mkdirSync(join(home, ".claude"));
      for (const doc of ["[]", '{"hooks":[]}', '{"hooks":{"PreToolUse":{}}}']) {
        writeFileSync(userSettingsPath(home), doc);
        const r = await installUserGates(home);
        assert.equal(r.action, "failed", doc);
        assert.equal(readFileSync(userSettingsPath(home), "utf-8"), doc);
      }
    }),
  );

  it(
    "writes nothing in read-only mode",
    withHome(async (home) => {
      const prev = process.env.KIT_READ_ONLY;
      process.env.KIT_READ_ONLY = "1";
      try {
        const r = await installUserGates(home);
        assert.equal(r.action, "skipped");
        assert.equal(existsSync(userSettingsPath(home)), false);
      } finally {
        if (prev === undefined) delete process.env.KIT_READ_ONLY;
        else process.env.KIT_READ_ONLY = prev;
      }
    }),
  );
});

describe("describeUserGates", () => {
  it("names the file, each gate, the backup and the reach", () => {
    const lines = describeUserGates({
      file: "/h/.claude/settings.json",
      action: "updated",
      backup: "/h/.claude/settings.json.bak",
      gates: [
        { gate: "gate-bash", result: { file: ".claude/settings.json", action: "updated" } },
        { gate: "gate-env", result: { file: ".claude/settings.json", action: "unchanged" } },
      ],
    });
    assert.deepEqual(lines, [
      "/h/.claude/settings.json: updated",
      "  gate-bash: updated",
      "  gate-env: unchanged",
      "the file as it was: /h/.claude/settings.json.bak",
      "Claude Code now runs these gates in every project on this machine.",
    ]);
    const failed = describeUserGates({ file: "/f", action: "failed", detail: "why", gates: [] });
    assert.deepEqual(failed, ["/f: failed (why)"]);
  });
});
