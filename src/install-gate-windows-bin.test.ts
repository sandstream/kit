import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInstallCommand } from "./install-gate.js";

describe("the install gate reads a Windows binary name as the package manager", () => {
  const named = [
    ["npm.cmd install left-pad", "npm:left-pad"],
    ["NPM.CMD install left-pad", "npm:left-pad"],
    ["pnpm.exe add left-pad", "npm:left-pad"],
    ["yarn.cmd add left-pad", "npm:left-pad"],
    ["bun.exe add left-pad", "npm:left-pad"],
    ["/c/nodejs/npm.cmd i left-pad", "npm:left-pad"],
    ["npx.cmd left-pad", "npm:left-pad"],
  ] as const;
  for (const [command, ref] of named) {
    it(`gates ${command}`, () => {
      const parsed = parseInstallCommand(command);
      assert.equal(parsed.isInstall, true);
      assert.ok(parsed.refs.includes(ref), JSON.stringify(parsed.refs));
    });
  }

  it("marks a bare npm.cmd install", () => {
    assert.equal(parseInstallCommand("npm.cmd install").bareInstall, true);
    assert.equal(parseInstallCommand("npm.cmd ci").bareInstall, true);
  });

  it("does not treat a package that ends in .cmd as a binary", () => {
    const parsed = parseInstallCommand("npm install foo.cmd");
    assert.ok(parsed.refs.includes("npm:foo.cmd"), JSON.stringify(parsed.refs));
  });
});
