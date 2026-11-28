import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  passWarningLines,
  triageWarnings,
  warningsField,
  writeInstallWarnings,
} from "./triage-warnings.js";
import { gateInstall, type GateDeps } from "./triage-gate.js";
import { installTools, type InstallDeps } from "./install.js";

// The shape `kit triage pip` printed for a fixture release one day old (a2ui note, 2026-11-12).
const REPORT = [
  "Triage: pip fixture-pkg",
  "--------------------------------------------------",
  "  . triaged 0.11.0, 16 releases, author: unknown",
  "  ! WARNING: no declared license -- review terms before use",
  "  ~ NOT CHECKED: maintainer count -- not exposed",
  "",
  "  ! WARNING: cooling: 0.11.0 was published 1 days ago, limit 14",
  "Health score: 88/100",
  "Warnings: 2",
  "TRIAGE PASSED",
].join("\n");

const passingDeps = (output: string): GateDeps => ({
  runTriage: async (type, target) => ({ type, target, passed: true, output }),
});

describe("triageWarnings", () => {
  it("returns each WARNING line's text, in order", () => {
    assert.deepEqual(triageWarnings(REPORT), [
      "no declared license -- review terms before use",
      "cooling: 0.11.0 was published 1 days ago, limit 14",
    ]);
  });

  it("returns nothing for a clean report, or a WARNING that is not at the start of a line", () => {
    assert.deepEqual(triageWarnings("Triage: npm x\nWarnings: 0\nTRIAGE PASSED"), []);
    assert.deepEqual(triageWarnings("  . description says ! WARNING: not a warning"), []);
  });

  it("replaces control characters a registry string could carry", () => {
    assert.deepEqual(triageWarnings("  ! WARNING: name \u001b[31mred\u0007 here"), [
      "name  [31mred  here",
    ]);
  });
});

describe("passing verdicts carry their warnings", () => {
  it("gateInstall puts the report's warnings on a pass", async () => {
    const v = await gateInstall("pip:fixture-pkg", passingDeps(REPORT));
    assert.equal(v.decision, "pass");
    assert.deepEqual(v.warnings, triageWarnings(REPORT));
  });

  it("gateInstall adds no warnings field to a clean pass", async () => {
    const v = await gateInstall("pip:fixture-pkg", passingDeps("TRIAGE PASSED"));
    assert.equal(v.decision, "pass");
    assert.equal("warnings" in v, false);
    assert.deepEqual(warningsField("TRIAGE PASSED"), {});
  });

  it("installTools keeps the warnings on the installed result", async () => {
    let installed = false; // the first check finds it missing, the re-check after install finds it
    const deps: InstallDeps = {
      checkTools: async () => {
        const status = installed
          ? { name: "pipx:fixture-pkg", required: "1", installed: "1", ok: true }
          : { name: "pipx:fixture-pkg", required: "1", installed: null, ok: false };
        installed = true;
        return [status];
      },
      miseInstall: async () => ({ ok: true, detail: "" }),
      resolveVersion: async (_tool, version) => ({ kind: "pinned", version }),
      gateInstall: async (tool) => ({
        tool,
        decision: "pass",
        reason: "ok",
        warnings: ["cooling: x"],
      }),
    };
    const [r] = await installTools({ "pipx:fixture-pkg": "1" }, deps);
    assert.equal(r.action, "installed");
    assert.deepEqual(r.warnings, ["cooling: x"]);
  });
});

describe("the stderr lines", () => {
  it("names the gate and the tool, and skips blocked verdicts", () => {
    assert.deepEqual(
      passWarningLines("kit install-gate", [
        { tool: "pip:a", decision: "pass", warnings: ["cooling: 1 day"] },
        { tool: "npm:b", decision: "pass" },
        { tool: "npm:c", decision: "blocked", warnings: ["never shown"] },
      ]),
      ["kit install-gate: warning: pip:a: cooling: 1 day"],
    );
  });

  it("kit install writes one plain line per warning to stderr", (t) => {
    const written: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string) => {
      written.push(chunk);
      return true;
    });
    writeInstallWarnings([
      { name: "pipx:a", warnings: ["no declared license", "cooling: 2 days"] },
      { name: "node" },
    ]);
    assert.deepEqual(written, [
      "kit install: warning: pipx:a: no declared license\n",
      "kit install: warning: pipx:a: cooling: 2 days\n",
    ]);
  });
});
