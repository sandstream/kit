import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRow, describeRuntime, safeMessage } from "./upstream.js";

const ESC = String.fromCharCode(27);

describe("kit upstream output carries no terminal control characters", () => {
  it("cleans a package row whose label, package, manifest and detail came from a repository", () => {
    const lines = describeRow({
      id: "acme",
      label: `Acme${ESC}[2J`,
      package: `acme${ESC}[31m`,
      manifest: `web${ESC}]0;x/package.json`,
      installed: "1.0.0",
      installedSource: "package-lock.json",
      range: "^1.0.0",
      latest: "1.1.0",
      bump: "minor",
      verdict: "upgrade available",
      notes: [{ tag: `v1${ESC}[2J`, url: "u", line: `- deprecated${ESC}[2J`, keyword: "deprecat" }],
      notesAvailable: true,
      detail: `bad${ESC}[2J`,
    });
    assert.ok(
      lines.every(
        (l) =>
          !l.includes(ESC.concat("[2J")) &&
          !l.includes(`${ESC}]0`) &&
          !l.includes(`${ESC}[31m${"acme"}`),
      ),
    );
    assert.ok(lines.join("\n").includes("acme"));
  });

  it("cleans a runtime row", () => {
    const lines = describeRuntime({
      id: "node",
      label: `Node${ESC}[2J`,
      installed: "22.0.0",
      declared: `22${ESC}[2J`,
      declaredFrom: `.nvmrc${ESC}`,
      latest: "22.1.0",
      verdict: "security release available",
      evidence: [`line${ESC}[2J`],
      detail: `d${ESC}[2J`,
    });
    assert.ok(lines.every((l) => !l.includes(`${ESC}[2J`)));
  });

  it("cleans an error message", () => {
    assert.ok(!safeMessage(new Error(`[upstream.bad${ESC}[2J] must be a table`)).includes(ESC));
    assert.equal(safeMessage("plain"), "plain");
  });
});
