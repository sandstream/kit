import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { windowsShellBodies } from "./install-gate-shells.js";
import { parseInstallCommand } from "./install-gate.js";

// PowerShell's -EncodedCommand is base64 of UTF-16LE text.
const encoded = (text: string) => Buffer.from(text, "utf16le").toString("base64");

describe("install gate: Windows shells carry an install", () => {
  // kit-research clickfix-vs-kit-install-gate: the first three passed silently (BREAK).
  const carriers: Array<[string, string]> = [
    ["cmd /c npm install gate-fixture", "npm:gate-fixture"],
    ['powershell -c "npm install gate-fixture"', "npm:gate-fixture"],
    ['pwsh -Command "pip install gate-fixture"', "pip:gate-fixture"],
    ["cmd.exe /C npm i gate-fixture", "npm:gate-fixture"],
    ['CMD /S /C "npm install gate-fixture"', "npm:gate-fixture"],
    ["C:\\Windows\\System32\\cmd.exe /d /c npm i gate-fixture", "npm:gate-fixture"],
    ["cmd /k npm i gate-fixture", "npm:gate-fixture"],
    ['PowerShell.exe -NoProfile -w hidden -Command "npm i gate-fixture"', "npm:gate-fixture"],
    ['pwsh -NoLogo -com "npm i gate-fixture"', "npm:gate-fixture"],
    ['powershell /Command "npm i gate-fixture"', "npm:gate-fixture"],
    ["powershell -ExecutionPolicy Bypass npm i gate-fixture", "npm:gate-fixture"],
    ['powershell "npm i gate-fixture"', "npm:gate-fixture"],
    [`powershell -enc ${encoded("npm install gate-fixture")}`, "npm:gate-fixture"],
    [`pwsh -EncodedCommand ${encoded("pip install gate-fixture")}`, "pip:gate-fixture"],
    ['cmd /c "echo ok && npm install gate-fixture"', "npm:gate-fixture"],
    ['echo start; powershell -c "npm i gate-fixture"', "npm:gate-fixture"],
    // Found by mutation testing (kit-research mutation-testing-vs-kit-gates): each case kills a
    // mutant that otherwise let the install through.
    ['echo a;powershell -c "npm i gate-fixture"', "npm:gate-fixture"],
    [`powershell -ec ${encoded("npm i gate-fixture")}`, "npm:gate-fixture"],
    [`powershell -enc ${encoded("npm i gate-fixture1")}`, "npm:gate-fixture1"],
    ["CMD /K npm i gate-fixture", "npm:gate-fixture"],
    ["PowerShell.exe -ExecutionPolicy Bypass npm i gate-fixture", "npm:gate-fixture"],
    ["cmd /q/c npm i gate-fixture", "npm:gate-fixture"],
    ["cmd /e:on/c npm i gate-fixture", "npm:gate-fixture"],
  ];
  for (const [command, ref] of carriers) {
    it(`gates the install inside: ${command}`, () => {
      const probe = parseInstallCommand(command);
      assert.equal(probe.isInstall, true);
      assert.ok(probe.refs.includes(ref), JSON.stringify(probe.refs));
    });
  }

  for (const command of [
    "cmd /c echo hello",
    'powershell -c "Get-ChildItem"',
    "pwsh -File build.ps1",
    "cmd",
    "powershell -NoProfile",
    "echo cmdlet /c",
  ]) {
    it(`does not gate a shell that installs nothing: ${command}`, () => {
      assert.equal(parseInstallCommand(command).isInstall, false);
    });
  }
});

describe("windowsShellBodies", () => {
  it("reads cmd's text after /c, with and without its outer quotes", () => {
    assert.deepEqual(windowsShellBodies('cmd /s /c "npm i x"'), ['"npm i x"', "npm i x"]);
  });

  it("does not read a pwsh positional as a command: pwsh's default is -File", () => {
    assert.deepEqual(windowsShellBodies("pwsh script.ps1"), []);
  });

  it("ignores an -EncodedCommand value that is not base64", () => {
    assert.deepEqual(windowsShellBodies("powershell -enc not*base64"), []);
  });

  it("stops at the end of the line", () => {
    assert.deepEqual(windowsShellBodies("cmd /c echo a\nnpm i x"), ["echo a"]);
  });

  it("is bounded on long input", () => {
    const long = `cmd /c ${"a".repeat(100_000)}`;
    assert.ok(windowsShellBodies(long).every((body) => body.length <= 4000));
  });
});
