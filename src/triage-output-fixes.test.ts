/**
 * Three output errors from kit-research supply-chain-2026-fundamentals-vs-kit:
 *  - a cooling WARNING printed above a summary that said `Warnings: 0`;
 *  - `kit triage vscode x` listed 8 of the 17 types `kit triage` accepts;
 *  - `kit doctor` said "no OS containment detected" while its verdict below said `mechanism: vm`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withCoolingLines } from "./triage-cooling.js";
import { containmentPostureStatus } from "./doctor.js";
import { detectContainment } from "./containment.js";

const REPORT = [
  "Triage: npm fixture",
  "  . triaged 1.0.1 (latest 1.0.1), 2 versions",
  "",
  "Health score: 100/100",
  "Critical issues: 0",
  "Warnings: 0",
  "TRIAGE PASSED",
].join("\n");

describe("triage output", () => {
  it("counts a cooling warning in the summary", () => {
    const out = withCoolingLines(REPORT, {
      lines: ["  ! WARNING: cooling: 1.0.1 was published 0 days ago, limit 14"],
      held: false,
    });
    assert.match(out, /^Warnings: 1$/m);
    assert.match(out, /^TRIAGE PASSED$/m);
  });

  it("leaves the count alone for a NOT CHECKED line", () => {
    const out = withCoolingLines(REPORT, {
      lines: ["  ~ NOT CHECKED: cooling -- off"],
      held: false,
    });
    assert.match(out, /^Warnings: 0$/m);
  });

  it("lists every type an unknown type could have meant", () => {
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const r = spawnSync(process.execPath, [cli, "triage", "vscode", "x"], {
      encoding: "utf8",
      env: { ...process.env, KIT_NO_UPDATE_CHECK: "1" },
      timeout: 60_000,
    });
    for (const type of ["gem", "instructions", "mcp", "model", "pkg"]) {
      assert.match(r.stderr, new RegExp(`Valid types: .*\\b${type}\\b`), r.stderr);
    }
  });
});

describe("doctor's containment row", () => {
  it("names a detected VM even when no install gate is wired", () => {
    const r = containmentPostureStatus(
      detectContainment({ hypervisor: true, seccompMode: 0 }),
      false,
    );
    assert.equal(r.status, "skip");
    assert.match(r.detail, /running in a VM/);
    assert.doesNotMatch(r.detail, /no OS containment detected/);
  });
});
