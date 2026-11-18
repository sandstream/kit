import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideSessionLimits,
  hasLimits,
  readSessionState,
  sessionStatePath,
  writeSessionState,
  type SessionState,
} from "./session-limits.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { installLimitsGate } from "./agent-config.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const fresh: SessionState = { start: T0.toISOString(), calls: 0, agents: 0 };

describe("decideSessionLimits", () => {
  it("counts a call, and a Task/Agent call as a child agent", () => {
    const r = decideSessionLimits({ maxToolCalls: 10 }, null, "Agent", T0);
    assert.deepEqual(r, { next: { start: T0.toISOString(), calls: 1, agents: 1 } });
  });

  it("refuses once the tool-call limit is reached", () => {
    const r = decideSessionLimits({ maxToolCalls: 2 }, { ...fresh, calls: 2 }, "Bash", T0);
    assert.ok("refuse" in r && /2 tool calls \(limit 2\)/.test(r.refuse));
  });

  it("refuses once the session has run its minutes", () => {
    assert.ok("next" in decideSessionLimits({ maxSessionMinutes: 30 }, fresh, "Read", at(29)));
    assert.ok("refuse" in decideSessionLimits({ maxSessionMinutes: 30 }, fresh, "Read", at(30)));
  });

  it("refuses another child agent at the limit, but not another plain call", () => {
    const state = { ...fresh, agents: 2 };
    assert.ok("refuse" in decideSessionLimits({ maxChildAgents: 2 }, state, "Task", T0));
    assert.ok("next" in decideSessionLimits({ maxChildAgents: 2 }, state, "Bash", T0));
  });

  it("no limit set means nothing to enforce", () => {
    assert.equal(hasLimits({}), false);
    assert.equal(hasLimits({ maxChildAgents: 0 }), true);
  });
});

describe("session state file", () => {
  it("round-trips, hashes the id into the name, and ignores garbage", (t) => {
    const home = mkdtempSync(join(tmpdir(), "kit-sess-"));
    t.after(() => rmTemp(home));
    const path = sessionStatePath(home, "../../etc/passwd");
    assert.match(path, /[0-9a-f]{32}\.json$/);
    writeSessionState(path, { ...fresh, calls: 3 });
    assert.deepEqual(readSessionState(path), { ...fresh, calls: 3 });
    writeFileSync(path, "nope");
    assert.equal(readSessionState(path), null);
  });
});

describe("kit gate-limits (compiled)", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

  it("allows up to the limit, then refuses with exit 2", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-limits-gate-"));
    t.after(() => rmTemp(dir));
    spawnSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir, ".kit.toml"), "[governance.agent]\nmax_tool_calls_per_session = 2\n");
    const call = () =>
      spawnSync(process.execPath, [CLI, "gate-limits"], {
        cwd: dir,
        input: JSON.stringify({ session_id: "s-1", tool_name: "Read", tool_input: {} }),
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: join(dir, ".home"),
          USERPROFILE: join(dir, ".home"),
          KIT_HIDE_HOOK_SKIP_BANNER: "1",
          KIT_AUDIT_ANCHOR: "0",
          KIT_NO_UPDATE_CHECK: "1",
        },
        timeout: 60_000,
      });
    assert.equal(call().status, 0);
    assert.equal(call().status, 0);
    const third = call();
    assert.equal(third.status, 2, third.stderr);
    assert.match(third.stderr, /limit 2/);
  });
});

describe("installLimitsGate", () => {
  it("wires gate-limits for every tool once, and leaves it alone the second time", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-limits-install-"));
    t.after(() => rmTemp(dir));
    spawnSync("git", ["init", "-q", dir]);
    mkdirSync(join(dir, ".claude"));
    const first = await installLimitsGate(dir);
    assert.equal(first.action, "created");
    const settings = JSON.parse(readFileSync(join(dir, first.file), "utf8")) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    const group = settings.hooks.PreToolUse.find((g) =>
      g.hooks[0]?.command.endsWith("gate-limits"),
    );
    assert.equal(group?.matcher, "*");
    assert.equal((await installLimitsGate(dir)).action, "unchanged");
  });
});
