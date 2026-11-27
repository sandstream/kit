import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateLiveness } from "./agent-config.js";
import { userGateCommands, userSettingsPath, withUserGates } from "./gate-liveness-user.js";
import { checkGateLiveness } from "./check-security.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const q = (s: string) => `"${s}"`;
const NONE: GateLiveness = {
  everInstalled: false,
  installGate: false,
  envGate: false,
  egressGate: false,
  problems: [],
};

/** A fake home with a startable kit CLI and the given user-level PreToolUse gate subcommands. */
function home(subs: string[], extra: Record<string, unknown> = {}): { dir: string; cli: string } {
  const dir = mkdtempSync(join(tmpdir(), "kit-user-gates-"));
  const cli = join(dir, "cli.js");
  writeFileSync(cli, "");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const hooks = subs.map((sub) => ({
    matcher: "Bash",
    hooks: [{ type: "command", command: `${q(process.execPath)} ${q(cli)} ${sub}` }],
  }));
  writeFileSync(userSettingsPath(dir), JSON.stringify({ ...extra, hooks: { PreToolUse: hooks } }));
  return { dir, cli };
}

describe("withUserGates", () => {
  it("counts both gates in ~/.claude/settings.json as wired and installed", () => {
    const { dir } = home(["gate-bash", "gate-env"]);
    try {
      const live = withUserGates(NONE, dir);
      assert.equal(live.everInstalled, true);
      assert.equal(live.installGate, true);
      assert.equal(live.envGate, true);
      assert.deepEqual(live.problems, []);
    } finally {
      rmTemp(dir);
    }
  });

  it("leaves the project view unchanged when the user file has no kit gate", () => {
    const empty = mkdtempSync(join(tmpdir(), "kit-user-gates-"));
    const other = home(["not-a-gate"]);
    try {
      assert.equal(withUserGates(NONE, empty), NONE);
      assert.equal(withUserGates(NONE, other.dir), NONE);
    } finally {
      rmTemp(empty);
      rmTemp(other.dir);
    }
  });

  it("reports one user gate without the other as installed with a hole", () => {
    const { dir } = home(["gate-bash"]);
    try {
      const live = withUserGates(NONE, dir);
      assert.equal(live.everInstalled, true);
      assert.equal(live.installGate, true);
      assert.equal(live.envGate, false);
    } finally {
      rmTemp(dir);
    }
  });

  it("reports a user gate whose kit CLI is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-user-gates-"));
    try {
      mkdirSync(join(dir, ".claude"));
      const cmd = `${q(process.execPath)} ${q(join(dir, "gone.js"))} gate-bash`;
      const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ command: cmd }] }] };
      writeFileSync(userSettingsPath(dir), JSON.stringify({ hooks }));
      assert.match(withUserGates(NONE, dir).problems.join(), /kit CLI missing/);
    } finally {
      rmTemp(dir);
    }
  });

  it("reads no settings.local.json at user level, and nothing from an unparseable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-user-gates-"));
    try {
      mkdirSync(join(dir, ".claude"));
      const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "/x/kit gate-bash" }] }] };
      writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ hooks }));
      assert.deepEqual(userGateCommands(dir), []);
      writeFileSync(userSettingsPath(dir), "{ not json");
      assert.deepEqual(userGateCommands(dir), []);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkGateLiveness with user-level gates", () => {
  it("passes a checkout with no project gates when ~/.claude/settings.json wires both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-live-user-proj-"));
    const home = mkdtempSync(join(tmpdir(), "kit-live-user-home-"));
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows; set both to the fake home.
    const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const cli = join(home, "cli.js");
      writeFileSync(cli, "");
      const cmd = (sub: string) => `"${process.execPath}" "${cli}" ${sub}`;
      mkdirSync(join(home, ".claude"));
      const hooks = {
        PreToolUse: [
          { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: cmd("gate-bash") }] },
          { matcher: "Write|Edit", hooks: [{ type: "command", command: cmd("gate-env") }] },
        ],
      };
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks }));
      const result = await checkGateLiveness(dir, {});
      assert.equal(result.status, "pass", result.detail);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmTemp(dir);
      rmTemp(home);
    }
  });
});
