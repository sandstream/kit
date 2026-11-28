/**
 * Cline's auto-approve. Fixture shapes are from cline/cline `main` (read 2026-11-28):
 * `apps/cli/src/tests/configs/default/data/globalState.json` (an `autoApprovalSettings` block with
 * `executeSafeCommands: true`) and `apps/vscode/src/sdk/sdk-tool-policies.ts` (`run_commands` is
 * approved when `executeSafeCommands` is true).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkClineAutoApprove,
  clineAutoApprovesCommands,
  clineDataDir,
} from "./check-cline-auto-approve.js";
import { checkAgentConfig } from "./check-agent-config.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const actions = (over: Record<string, boolean>) => ({
  autoApprovalSettings: {
    version: 19,
    enabled: true,
    actions: { readFiles: true, editFiles: false, executeSafeCommands: false, ...over },
  },
});

function homeWith(state: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "kit-cline-home-"));
  mkdirSync(join(home, ".cline", "data"), { recursive: true });
  const body = typeof state === "string" ? state : JSON.stringify(state);
  writeFileSync(join(home, ".cline", "data", "globalState.json"), body);
  return home;
}

describe("clineAutoApprovesCommands", () => {
  it("names the setting that runs commands without asking", () => {
    assert.match(
      clineAutoApprovesCommands(actions({ executeSafeCommands: true })) ?? "",
      /executeSafeCommands: true/,
    );
    assert.match(
      clineAutoApprovesCommands(actions({ executeAllCommands: true })) ?? "",
      /executeAllCommands: true/,
    );
    assert.equal(clineAutoApprovesCommands({ yoloModeToggled: true }), "yoloModeToggled: true");
    assert.equal(
      clineAutoApprovesCommands({ autoApproveAllToggled: true }),
      "autoApproveAllToggled: true",
    );
  });
  it("leaves commands that ask alone", () => {
    assert.equal(clineAutoApprovesCommands(actions({ readFiles: true })), null);
    assert.equal(clineAutoApprovesCommands({ yoloModeToggled: false }), null);
    assert.equal(clineAutoApprovesCommands({}), null);
    assert.equal(clineAutoApprovesCommands(null), null);
    assert.equal(clineAutoApprovesCommands([]), null);
  });
});

describe("clineDataDir", () => {
  it("follows Cline's precedence and never shows the home path", () => {
    assert.deepEqual(clineDataDir("/h", { CLINE_DATA_DIR: " /d " }), {
      dir: "/d",
      shown: "$CLINE_DATA_DIR",
    });
    assert.deepEqual(clineDataDir("/h", { CLINE_DIR: "/c" }), {
      dir: join("/c", "data"),
      shown: "$CLINE_DIR/data",
    });
    assert.deepEqual(clineDataDir("/h", {}), {
      dir: join("/h", ".cline", "data"),
      shown: "~/.cline/data",
    });
  });
});

describe("checkClineAutoApprove", () => {
  it("warns when Cline runs commands without asking", () => {
    const home = homeWith(actions({ executeSafeCommands: true }));
    try {
      const [row, ...rest] = checkClineAutoApprove(home, {});
      assert.equal(rest.length, 0);
      assert.equal(row?.status, "warn");
      assert.equal(row?.severity, "high");
      assert.match(row?.detail ?? "", /~\/\.cline\/data\/globalState\.json/);
      assert.match(row?.detail ?? "", /bypassPermissions/);
      assert.match(row?.suggestion ?? "", /Execute commands/);
      assert.doesNotMatch(row?.detail ?? "", new RegExp(home.replace(/[\\.]/g, "\\$&")));
    } finally {
      rmTemp(home);
    }
  });
  it("passes when commands ask, and is silent without Cline or with a broken file", () => {
    for (const [state, rows] of [
      [actions({}), 1],
      ["{not json", 0],
    ] as const) {
      const home = homeWith(state);
      try {
        const got = checkClineAutoApprove(home, {});
        assert.equal(got.length, rows);
        if (rows) assert.equal(got[0]?.status, "pass");
      } finally {
        rmTemp(home);
      }
    }
    const empty = mkdtempSync(join(tmpdir(), "kit-cline-none-"));
    try {
      assert.deepEqual(checkClineAutoApprove(empty, {}), []);
    } finally {
      rmTemp(empty);
    }
  });
  it("is a row of kit check's agent view", async () => {
    const home = homeWith({ yoloModeToggled: true });
    const root = mkdtempSync(join(tmpdir(), "kit-cline-root-"));
    try {
      const rows = await checkAgentConfig(root, home, {});
      const row = rows.find((r) => r.name === "cline auto-approve");
      assert.equal(row?.status, "warn");
      assert.match(row?.detail ?? "", /yoloModeToggled: true/);
    } finally {
      rmTemp(home);
      rmTemp(root);
    }
  });
});
