import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mayChangeDirectory } from "./install-gate-cwd.js";
import { decideBashGate } from "./install-gate.js";
import type { GateDeps } from "./triage-gate.js";

describe("mayChangeDirectory", () => {
  it("sees cd, pushd and Set-Location anywhere in the command, and dir flags", () => {
    for (const cmd of [
      "cd '../other' && npx tool",
      "npm run build; cd /tmp && npx tool",
      "pushd ../x && npx tool",
      "Set-Location ..\\x; npx tool",
      "npm --prefix ../x exec tool",
      "yarn --cwd=../x dlx tool",
    ])
      assert.equal(mayChangeDirectory(cmd), true, cmd);
  });

  it("is false for a command that stays in the hook's directory", () => {
    for (const cmd of ["npx tsc --noEmit", "echo cd && npx tsc", "npx tsc --project cd.json"])
      assert.equal(mayChangeDirectory(cmd), false, cmd);
  });
});

describe("decideBashGate: the npx shadow check reads the directory npx runs in", () => {
  it("triages `cd <elsewhere> && npx <name>` even when the hook's cwd has a local .bin/<name>", async () => {
    // Was: exit 0 with no triage — the local bin was looked up in the hook's cwd, while npx ran
    // in ../other and fetched the registry package (kit-research claude-code-code-mode-vs-kit).
    const dir = mkdtempSync(join(tmpdir(), "kit-npx-cd-"));
    try {
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules", ".bin", "lab-shadow"), "#!/bin/sh\n");
      let triaged = 0;
      const deps: GateDeps = {
        runTriage: async (type, target) => {
          triaged++;
          return { type, target, passed: false, output: "TRIAGE FAILED" };
        },
      };
      const moved = await decideBashGate("cd '../other' && npx lab-shadow", deps, dir);
      assert.equal(moved.block, true);
      assert.equal(triaged, 1);
      const stayed = await decideBashGate("npx lab-shadow", deps, dir);
      assert.equal(stayed.block, false, "in place, the local bin still shadows the registry name");
      assert.equal(triaged, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
