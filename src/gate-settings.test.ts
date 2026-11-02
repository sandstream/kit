import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { gateLiveness, installEnvWriteGate, installInstallGate } from "./agent-config.js";

const SHARED = ".claude/settings.json";
const LOCAL = ".claude/settings.local.json";
const SHARED_CONTENT =
  JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }, null, 2) + "\n";

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
}

/** A git repo whose `.claude/settings.json` is committed (shared), or left untracked. */
function repo(tracked: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-gate-file-"));
  git(dir, "init", "-q");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, SHARED), SHARED_CONTENT);
  if (tracked) {
    git(dir, "add", SHARED);
    git(dir, "commit", "-q", "-m", "shared settings");
  }
  return dir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

describe("where the PreToolUse gates are written", () => {
  it("goes to settings.local.json when settings.json is committed, and leaves the shared file alone", async () => {
    const dir = repo(true);
    try {
      const result = await installInstallGate(dir);
      assert.equal(result.file, LOCAL);
      assert.equal(read(dir, SHARED), SHARED_CONTENT);
      assert.match(read(dir, LOCAL), /gate-bash/);
    } finally {
      rmTemp(dir);
    }
  });

  it("keeps writing settings.json when that file is not committed", async () => {
    const dir = repo(false);
    try {
      const result = await installInstallGate(dir);
      assert.equal(result.file, SHARED);
      assert.match(read(dir, SHARED), /gate-bash/);
      assert.equal(existsSync(join(dir, LOCAL)), false);
    } finally {
      rmTemp(dir);
    }
  });

  it("puts both gates in the local file, and a second run changes nothing", async () => {
    const dir = repo(true);
    try {
      await installInstallGate(dir);
      await installEnvWriteGate(dir);
      assert.equal((await installInstallGate(dir)).action, "unchanged");
      assert.equal((await installEnvWriteGate(dir)).action, "unchanged");
      const local = read(dir, LOCAL);
      assert.match(local, /gate-bash/);
      assert.match(local, /gate-env/);
      assert.equal(read(dir, SHARED), SHARED_CONTENT);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("gateLiveness reads both settings files", () => {
  it("sees gates that live in settings.local.json", async () => {
    const dir = repo(true);
    try {
      await installInstallGate(dir);
      await installEnvWriteGate(dir);
      const live = gateLiveness(dir);
      assert.equal(live.installGate, true);
      assert.equal(live.envGate, true);
    } finally {
      rmTemp(dir);
    }
  });

  it("sees a gate in each file", async () => {
    const dir = repo(false);
    try {
      await installInstallGate(dir); // untracked: written to settings.json
      writeFileSync(
        join(dir, LOCAL),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "Write", hooks: [{ type: "command", command: "kit gate-env" }] },
            ],
          },
        }),
      );
      const live = gateLiveness(dir);
      assert.equal(live.installGate, true);
      assert.equal(live.envGate, true);
    } finally {
      rmTemp(dir);
    }
  });

  it("still reports a gate that is in neither file as missing", async () => {
    const dir = repo(true);
    try {
      await installInstallGate(dir);
      const live = gateLiveness(dir);
      assert.equal(live.installGate, true);
      assert.equal(live.envGate, false);
    } finally {
      rmTemp(dir);
    }
  });
});
