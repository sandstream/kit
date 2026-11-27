/**
 * What the release-binary gate leaves alone: a download, extraction or local script with no chain
 * from a fetch to execution or PATH.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand } from "./install-gate.js";
import { destinationKind, extractOf, runOperand } from "./install-gate-release-uses.js";

const URL_ = "https://h.example/releases/v1.2.3/tool-linux-amd64.tar.gz";

const ALLOWED = [
  `curl -fsSLO ${URL_}`,
  "wget https://h.example/data.tar.gz && tar xzf data.tar.gz",
  "curl -O https://h.example/data.tar.gz && tar xzf data.tar.gz && python train.py",
  "curl -O https://h.example/data.tar.gz && tar xzf data.tar.gz && make train",
  "curl -LO https://h.example/data.tgz && tar xzf data.tgz -C ~/datasets",
  "chmod +x ./scripts/build.sh && ./scripts/build.sh",
  "git clone https://github.com/acme/tool && cd tool && make && ./bin/tool",
  "curl -s https://h.example/a.json -o a.json && jq . a.json",
  "tar xzf vendored.tgz && ./vendored/run",

  "iwr https://h.example/data.csv -OutFile data.csv; Import-Csv data.csv",
];

describe("release binary chains: what is not one", () => {
  for (const command of ALLOWED) {
    it(`no chain: ${command.slice(0, 80)}`, () => {
      assert.deepEqual(parseInstallCommand(command).releaseChains, []);
    });
  }

  it("reads extract destinations, run operands and PATH destinations", () => {
    assert.deepEqual(extractOf(["tar", "-xzf", "a.tgz", "-C", "/opt"]), {
      archives: ["a.tgz"],
      dest: "/opt",
    });
    assert.deepEqual(extractOf(["tar", "xz"]), { archives: "stdin", dest: undefined });
    assert.equal(extractOf(["tar", "tzf", "a.tgz"]), null, "listing is not extracting");
    assert.equal(runOperand(["python3", "-c", "print(1)"]), null);
    assert.equal(runOperand(["msiexec", "/i", "t.msi"]), "t.msi");
    assert.equal(destinationKind("~/.local/bin"), "path");
    assert.equal(destinationKind("C:\\Program Files\\T"), "path");
    assert.equal(destinationKind("$BIN"), "dynamic");
    assert.equal(destinationKind("vendor/bin"), "local");
  });
});
