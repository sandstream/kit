/**
 * The fetch and step forms the release-binary gate reads, each checked on its own as a chain
 * (through the parser that also opens `sh -c` and `powershell -Command`; no receipts involved:
 * install-gate-release.test.ts covers the receipt and the refusal).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand } from "./install-gate.js";
import { commandWords, fetchesOf } from "./install-gate-release-steps.js";

const POSIX = [
  "wget https://h.example/tool && chmod 755 tool",
  "wget -qO- https://h.example/t.tgz | tar xz && ./t/bin/x",
  "curl -L https://h.example/t.tgz | tar -xzf - -C /tmp/t && /tmp/t/bin/x --version",
  "gh release download v1 -R acme/tool -p tool.zip && unzip tool.zip && install -m 755 tool ~/.local/bin/tool",
  "curl -o t.zip https://h.example/t.zip; unzip -q t.zip -d out; cp out/tool $HOME/bin/",
  "curl -LO https://h.example/node.tar.xz && tar xJf node.tar.xz -C /usr/local --strip-components=1",
  "curl -o a.tgz https://h.example/a.tgz && mv a.tgz b.tgz && tar xzf b.tgz && ./b/run",
  "curl -o x.sh https://h.example/install.sh && sh x.sh",
  "curl -fsSL -o /tmp/i.bin https://h.example/i.bin && sudo /tmp/i.bin",
  "sh -c 'curl -sO https://h.example/t && chmod +x t'",
];

const POWERSHELL = [
  "Invoke-WebRequest -Uri https://h.example/t.zip -OutFile $env:TEMP\\t.zip; Expand-Archive $env:TEMP\\t.zip -DestinationPath $env:TEMP\\t; Move-Item $env:TEMP\\t\\t.exe $env:LOCALAPPDATA\\Microsoft\\WindowsApps",
  "iwr https://h.example/setup.exe -OutFile setup.exe; Start-Process .\\setup.exe",
  "iwr https://h.example/setup.exe -OutFile setup.exe; & .\\setup.exe /S",
  "Invoke-WebRequest https://h.example/t.zip -OutFile t.zip; Expand-Archive t.zip -DestinationPath 'C:\\Program Files\\T'",
  "Start-BitsTransfer -Source https://h.example/t.exe -Destination t.exe; Unblock-File t.exe",
  'powershell -Command "iwr https://h.example/t.exe -OutFile t.exe; .\\t.exe"',
];

describe("release binary chains: fetch tools and steps", () => {
  for (const command of [...POSIX, ...POWERSHELL]) {
    it(`chains: ${command.slice(0, 80)}`, () => {
      assert.notEqual(parseInstallCommand(command).releaseChains?.length ?? 0, 0, command);
    });
  }

  it("reads curl clusters, wget -O, Invoke-WebRequest -OutFile and gh release download", () => {
    const one = (c: string) =>
      fetchesOf(commandWords(c))!.map((f) => [f.url, f.names === "any" ? "any" : [...f.names]]);
    assert.deepEqual(one("curl -fsSLo t.tgz https://h.example/a"), [
      ["https://h.example/a", ["t.tgz"]],
    ]);
    assert.deepEqual(one("curl -OJ https://h.example/a"), [["https://h.example/a", "any"]]);
    assert.deepEqual(one("curl -H 'Authorization: token $T' -O https://h.example/a.zip"), [
      ["https://h.example/a.zip", ["a.zip"]],
    ]);
    assert.deepEqual(one("wget -O - https://h.example/a"), [["https://h.example/a", []]]);
    assert.deepEqual(one("iwr -Uri https://h.example/a.zip -OutFile $env:TEMP\\b.zip"), [
      ["https://h.example/a.zip", ["b.zip"]],
    ]);
    assert.deepEqual(one("gh release download v1 -R acme/t -p t.zip"), [
      ["https://github.com/acme/t/releases/download/v1/t.zip", ["t.zip"]],
    ]);
  });
});
