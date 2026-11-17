import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearStop, readStop, stopMarkerPath, writeStop } from "./stop-switch.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

function sandbox(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-stop-"));
  t.after(() => rmTemp(dir));
  spawnSync("git", ["init", "-q", dir]);
  const home = join(dir, ".home");
  mkdirSync(home, { recursive: true });
  const kit = (args: string[], input = "") =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      input,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        KIT_HIDE_HOOK_SKIP_BANNER: "1",
        KIT_AUDIT_ANCHOR: "0",
        KIT_NO_UPDATE_CHECK: "1",
      },
      timeout: 60_000,
    });
  return { home, kit };
}

const LS = JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } });

describe("stop switch state", () => {
  it("writes, reads and clears the marker", (t) => {
    const { home } = sandbox(t);
    assert.equal(readStop(home), null);
    writeStop(home, "drill", new Date(0));
    assert.deepEqual(readStop(home), { since: "1970-01-01T00:00:00.000Z", reason: "drill" });
    assert.equal(clearStop(home), true);
    assert.equal(readStop(home), null);
    assert.equal(clearStop(home), false);
  });

  it("an unreadable marker still stops (fail closed)", (t) => {
    const { home } = sandbox(t);
    mkdirSync(dirname(stopMarkerPath(home)), { recursive: true });
    writeFileSync(stopMarkerPath(home), "not json");
    assert.ok(readStop(home));
  });
});

describe("kit panic --stop and --resume drive every gate", () => {
  it("a harmless command passes, is refused while stopped, and passes after resume", (t) => {
    const { kit } = sandbox(t);
    assert.equal(kit(["gate-bash"], LS).status, 0, "before the stop");
    const stop = kit(["panic", "--stop", "--reason", "drill"]);
    assert.equal(stop.status, 0, stop.stderr);
    const refused = kit(["gate-bash"], LS);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /panic --stop is in effect/);
    assert.equal(
      kit(
        ["gate-env"],
        JSON.stringify({ tool_name: "Write", tool_input: { file_path: "a.txt", content: "x" } }),
      ).status,
      2,
    );
    assert.equal(kit(["panic", "--resume"]).status, 0);
    assert.equal(kit(["gate-bash"], LS).status, 0, "after resume");
  });
});
