/**
 * kit-research agent-platform-2027-vs-kit: `kit profile` reported an added skill or MCP server and
 * had no list for hooks, which the harness runs outside every gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverHooks, hooksFromSettings } from "./hooks.js";
import { computeProfileDrift, type DiscoveredState } from "./reconcile.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const GATE = '"$HOME/.kit/bin/kit" gate-bash';
const settings = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: GATE }] }],
      ...extra,
    },
  });
const stop = (command: string) => ({ Stop: [{ hooks: [{ type: "command", command }] }] });

function project(t: { after(fn: () => void): void }, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-profile-hooks-"));
  t.after(() => rmTemp(dir));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), text);
  writeFileSync(join(dir, "tools", "listen.js"), "// one\n");
  return dir;
}

const state = (hooks: DiscoveredState["hooks"]): DiscoveredState => ({
  skills: [],
  mcp: [],
  workflows: null,
  plugins: null,
  hooks,
});

describe("hooksFromSettings", () => {
  it("names a hook by event, matcher and command, and hashes the script it runs", (t) => {
    const dir = project(t, settings(stop("node ./tools/listen.js")));
    const found = discoverHooks(dir);
    assert.deepEqual(
      found.map((h) => h.name),
      [`PreToolUse[Bash]: ${GATE}`, "Stop: node ./tools/listen.js"],
    );
    assert.equal(found[0]?.version, undefined);
    assert.match(found[1]?.version ?? "", /^[0-9a-f]{16}$/);
  });

  it("gives a changed script another version, and no version to a missing one", (t) => {
    const dir = project(t, settings(stop("node ./tools/listen.js")));
    const before = discoverHooks(dir)[1]?.version;
    writeFileSync(join(dir, "tools", "listen.js"), "// two\n");
    assert.notEqual(discoverHooks(dir)[1]?.version, before);
    assert.equal(hooksFromSettings(settings(stop("node ./gone.js")), dir)[1]?.version, undefined);
  });

  it("returns nothing for text that does not parse, has no hooks, or no settings file", (t) => {
    assert.deepEqual(hooksFromSettings("{", "."), []);
    assert.deepEqual(hooksFromSettings('{"env":{}}', "."), []);
    const dir = mkdtempSync(join(tmpdir(), "kit-profile-hooks-none-"));
    t.after(() => rmTemp(dir));
    assert.deepEqual(discoverHooks(dir), []);
  });
});

describe("computeProfileDrift with hooks", () => {
  const frozen = [{ name: "Stop: node ./tools/listen.js", version: "aaaaaaaaaaaaaaaa" }];
  const base = { version: 1, generated: "1970-01-01T00:00:00.000Z" };

  it("reports an added hook, a removed one and a changed script", () => {
    const d = computeProfileDrift(
      { ...base, hooks: [...frozen, { name: "PreCompact: sh ./gone.sh" }] },
      state([
        { name: "Stop: node ./tools/listen.js", version: "bbbbbbbbbbbbbbbb" },
        { name: "SessionStart: node ./new.js" },
      ]),
    );
    assert.deepEqual(
      d.entries.map((e) => [e.kind, e.name, e.status]),
      [
        ["hook", "PreCompact: sh ./gone.sh", "removed"],
        ["hook", "SessionStart: node ./new.js", "added"],
        ["hook", "Stop: node ./tools/listen.js", "version-drift"],
      ],
    );
    assert.equal(d.driftCount, 3);
  });

  it("does not judge hooks against a profile frozen before they were recorded", () => {
    const d = computeProfileDrift(base, state([{ name: "Stop: node ./tools/listen.js" }]));
    assert.deepEqual(d.entries, []);
    assert.deepEqual(d.notRecorded, ["hook"]);
    assert.equal(d.clean, true);
  });

  it("treats a recorded empty list as a list: any hook is then added", () => {
    const d = computeProfileDrift({ ...base, hooks: [] }, state([{ name: "Stop: sh ./x.sh" }]));
    assert.equal(d.entries[0]?.status, "added");
    assert.deepEqual(d.notRecorded, []);
  });
});

describe("kit profile freeze and check (real CLI)", () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [cli, "profile", ...args], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, KIT_NO_UPDATE_CHECK: "1", KIT_HIDE_HOOK_SKIP_BANNER: "1" },
      timeout: 60_000,
    });

  it("records the hooks, then reports one added afterwards and fails with --gate", (t) => {
    const dir = project(t, settings());
    assert.match(run(dir, "freeze").stdout, /1 hook\(s\)/);
    assert.equal(run(dir, "check", "--gate").status, 0);
    writeFileSync(join(dir, ".claude", "settings.json"), settings(stop("node ./tools/listen.js")));
    const check = run(dir, "check", "--gate");
    assert.match(check.stdout, /hooks[\s\S]*ADDED[\s\S]*Stop: node \.\/tools\/listen\.js/);
    assert.notEqual(check.status, 0);
  });
});
