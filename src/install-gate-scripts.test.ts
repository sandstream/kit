import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installScriptBypass } from "./install-gate-scripts.js";
import { decideBashGate } from "./install-gate.js";

// kit-research supply-chain-2026-fundamentals-vs-kit: each of these passed gate-bash silently.
const GRANTS: Array<[string, string]> = [
  ["npm install-scripts approve esbuild --all", "approve-scripts <pkg> --all"],
  ["npm approve-scripts esbuild --all", "approve-scripts <pkg> --all"],
  ["npm approve-scripts --all esbuild", "approve-scripts <pkg> --all"],
  ["npm approve-scripts -a esbuild", "approve-scripts <pkg> --all"],
  ["npm install --dangerously-allow-all-scripts", "--dangerously-allow-all-scripts"],
  ["pnpm install --dangerously-allow-all-scripts=true", "--dangerously-allow-all-scripts"],
  [
    "npm config set dangerously-allow-all-scripts true",
    "npm config set dangerously-allow-all-scripts",
  ],
  ["npm config set ignore-scripts false", "npm config set ignore-scripts false"],
  ["npm config set --global ignore-scripts=false", "npm config set ignore-scripts false"],
  ["npm install --no-ignore-scripts", "ignore-scripts off"],
  ["npm ci --ignore-scripts=false", "ignore-scripts off"],
  ["npm_config_ignore_scripts=false npm ci", "npm_config_ignore_scripts=false"],
  [
    "env npm_config_dangerously_allow_all_scripts=true npm i",
    "npm_config_dangerously_allow_all_scripts",
  ],
  ['sh -c "npm i --dangerously-allow-all-scripts"', "--dangerously-allow-all-scripts"],
  ["sudo -u x npm config set ignore-scripts false", "npm config set ignore-scripts false"],
];

describe("install gate: blanket install-script grants", () => {
  for (const [command, named] of GRANTS) {
    it(`names it: ${command}`, () => {
      assert.equal(installScriptBypass(command), named);
    });
  }

  for (const command of [
    "npm approve-scripts esbuild",
    "npm install --ignore-scripts",
    "npm config set ignore-scripts true",
    "npm config set dangerously-allow-all-scripts false",
    "npm install-scripts ls --all",
    "npm approve-scripts --all", // no name: the matcher refuses it as approve-scripts-all
    "echo --dangerously-allow-all-scripts",
    "npm config get ignore-scripts",
  ]) {
    it(`leaves it to the existing gate: ${command}`, () => {
      assert.equal(installScriptBypass(command), null);
    });
  }

  it("refuses in the gate before any registry request, and says how to grant one package", async () => {
    const verdict = await decideBashGate("npm install-scripts approve esbuild --all");
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /turns on install scripts for packages nobody triaged/);
    assert.match(verdict.reason, /npm approve-scripts <pkg>/);
    assert.deepEqual(verdict.checked, []);
  });
});
