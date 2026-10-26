import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVAL_TOKENS_FILE } from "../approval-tokens.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));

/** Runs kit the way an agent's tool call does: no terminal on any stream. */
function kit(dir: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: join(dir, "proj"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: join(dir, "home"),
      KIT_IDENTITY_DIR: join(dir, "id"),
      KIT_MEMORY_DIR: join(dir, "mem"),
      KIT_AUDIT_ANCHOR_DIR: join(dir, "anchor"),
      ...env,
    },
  });
}

function withIdentity(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-approve-cli-"));
  t.after(() => rmTemp(dir));
  spawnSync("git", ["init", "-q", join(dir, "proj")]);
  assert.equal(kit(dir, ["identity", "init"]).status, 0, "identity init");
  return dir;
}

describe("kit policy approve: an approval stands for a person", () => {
  it("refuses without a terminal and writes no token", (t) => {
    const dir = withIdentity(t);
    const run = kit(dir, ["policy", "approve", "deploy"]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /not approved: an approval stands for a person/);
    assert.equal(existsSync(join(dir, "proj", APPROVAL_TOKENS_FILE)), false);
  });

  it("honors a hardware mandate before asking anyone", (t) => {
    const dir = withIdentity(t);
    const run = kit(dir, ["policy", "approve", "deploy"], { KIT_REQUIRE_HARDWARE_IDENTITY: "1" });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /hardware-rooted identity is REQUIRED/);
    assert.equal(existsSync(join(dir, "proj", APPROVAL_TOKENS_FILE)), false);
  });
});
