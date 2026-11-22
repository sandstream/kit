/**
 * `kit agent-audit --accept-user-surfaces` tells kit that a person has read the user-level agent
 * files that changed. An agent could run it itself after rewriting a skill, which made the drift
 * warning something the audited party could switch off. The gates refuse it from an agent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { trailCommandRefusal } from "./trail-guard.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const HOME = resolve("/h");

describe("trailCommandRefusal: accepting user-level agent files", () => {
  for (const cmd of [
    "kit agent-audit --accept-user-surfaces",
    '"$HOME/.kit/bin/kit" agent-audit --accept-user-surfaces',
    "cd /tmp && kit agent-audit --json --accept-user-surfaces",
    "kit.cmd agent-audit --accept-user-surfaces",
  ]) {
    it(`refuses: ${cmd}`, () => {
      assert.match(trailCommandRefusal(cmd, HOME) ?? "", /a person does that/);
    });
  }

  it("leaves the audit itself, and text that only mentions the flag, alone", () => {
    assert.equal(trailCommandRefusal("kit agent-audit", HOME), null);
    assert.equal(trailCommandRefusal("kit agent-audit --json", HOME), null);
    assert.equal(trailCommandRefusal("grep -rn -- --accept-user-surfaces src", HOME), null);
  });
});

describe("gate-bash refuses it (real CLI)", () => {
  it("exits 2 for the acceptance and 0 for the audit", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-accept-guard-"));
    t.after(() => rmTemp(dir));
    const home = join(dir, ".home");
    mkdirSync(home, { recursive: true });
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const gate = (command: string) =>
      spawnSync(process.execPath, [cli, "gate-bash"], {
        cwd: dir,
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          KIT_NO_UPDATE_CHECK: "1",
          KIT_AUDIT_ANCHOR: "0",
          KIT_HIDE_HOOK_SKIP_BANNER: "1",
        },
        timeout: 60_000,
      });
    const refused = gate("kit agent-audit --accept-user-surfaces");
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /accepts changed user-level agent files/);
    assert.equal(gate("kit agent-audit").status, 0);
  });
});
