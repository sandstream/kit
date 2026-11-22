import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { brewInstall } from "./install-gate-brew.js";
import type { GemProbe } from "./install-gate-gem.js";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import { triageTargetFor, type GateDeps } from "./triage-gate.js";
import { parseBrewInfo, type TriageType } from "./triage.js";

const probe = (): GemProbe => ({ isInstall: false, refs: [], unverifiable: [] });

/** Triage stub: records each call and passes every formula except `evil`. */
function stubDeps(calls: string[]): GateDeps {
  return {
    runTriage: async (type: TriageType, target: string) => {
      calls.push(`${type} ${target}`);
      const passed = target !== "evil";
      return { type, target, passed, output: passed ? "TRIAGE PASSED" : "Formula is DISABLED." };
    },
  };
}

describe("install gate: brew install", () => {
  const refs: Array<[string, string[]]> = [
    ["brew install jq", ["brew:jq"]],
    ["brew install jq ripgrep fd", ["brew:jq", "brew:ripgrep", "brew:fd"]],
    ["brew install python@3.12", ["brew:python@3.12"]],
    ["brew install hashicorp/tap/terraform", ["brew:hashicorp/tap/terraform"]],
    ["brew install --cask firefox", ["brew:homebrew/cask/firefox"]],
    ["brew install firefox --cask --appdir /Applications", ["brew:homebrew/cask/firefox"]],
    [
      "brew install --cask --appdir=/Applications a b",
      ["brew:homebrew/cask/a", "brew:homebrew/cask/b"],
    ],
    ["brew install --cask acme/tap/tool", ["brew:acme/tap/tool"]],
    ["brew install --build-from-source --HEAD jq", ["brew:jq"]],
    ["brew --verbose install jq", ["brew:jq"]],
    ["HOMEBREW_NO_AUTO_UPDATE=1 brew install jq", ["brew:jq"]],
    ["/opt/homebrew/bin/brew install jq", ["brew:jq"]],
    ['sh -c "brew install jq"', ["brew:jq"]],
    ["brew update && brew install jq", ["brew:jq"]],
  ];
  for (const [command, expected] of refs) {
    it(`gates ${command}`, () => {
      const parsed = parseInstallCommand(command);
      assert.equal(parsed.isInstall, true);
      assert.deepEqual(parsed.refs, expected);
      assert.deepEqual(parsed.unverifiable, []);
    });
  }
});

describe("install gate: brew installs that are refused", () => {
  const refused: Array<[string, RegExp]> = [
    [
      "brew install https://example.com/tool.rb",
      /UNVERIFIED SOURCE: https:\/\/example\.com\/tool\.rb\..*kit triage repo/,
    ],
    ["brew install ./tool.rb", /UNVERIFIED SOURCE: \.\/tool\.rb/],
    ["brew install tool.rb", /UNVERIFIED SOURCE: tool\.rb/],
    ["brew install /tmp/formula/tool", /UNVERIFIED SOURCE: \/tmp\/formula\/tool/],
    [
      "HOMEBREW_BOTTLE_DOMAIN=https://b.example brew install jq",
      /UNVERIFIED SOURCE: HOMEBREW_BOTTLE_DOMAIN/,
    ],
    [
      "HOMEBREW_CORE_GIT_REMOTE=https://g.example/core brew install jq",
      /UNVERIFIED SOURCE: HOMEBREW_CORE_GIT_REMOTE/,
    ],
    ["brew install 'bad name'", /cannot reduce to a triage target: brew:bad name/],
  ];
  for (const [command, reason] of refused) {
    it(`refuses ${command}`, async () => {
      const calls: string[] = [];
      const verdict = await decideBashGate(command, stubDeps(calls));
      assert.equal(verdict.block, true);
      assert.match(verdict.reason, reason);
      assert.match(verdict.reason, /fail-closed/);
      assert.deepEqual(calls, [], "a refused command is not triaged");
    });
  }
});

describe("install gate: brew commands that install no named formula", () => {
  const ignored = [
    "brew install",
    "brew list",
    "brew info jq",
    "brew --version",
    "brew search install",
    "brew uninstall jq",
    "brew services start postgresql",
  ];
  for (const command of ignored) {
    it(`is not an install of a named formula: ${command}`, () => {
      const parsed = parseInstallCommand(command);
      assert.equal(parsed.isInstall, false);
      assert.deepEqual(parsed.refs, []);
      assert.deepEqual(parsed.unverifiable, []);
    });
  }
});

describe("install gate: brew triage decides, one formula at a time", () => {
  it("triages each formula and stops at the first that does not pass", async () => {
    const calls: string[] = [];
    const verdict = await decideBashGate("brew install jq evil ripgrep", stubDeps(calls));
    assert.equal(verdict.block, true);
    assert.deepEqual(calls, ["brew jq", "brew evil"]);
    assert.match(verdict.reason, /triage did not pass \(brew evil\)/);
  });

  it("allows an install whose every formula passes", async () => {
    const calls: string[] = [];
    const verdict = await decideBashGate("brew install jq ripgrep", stubDeps(calls));
    assert.equal(verdict.block, false);
    assert.deepEqual(calls, ["brew jq", "brew ripgrep"]);
  });

  it("maps a brew: ref to brew triage, tap names included", () => {
    for (const name of ["jq", "hashicorp/tap/terraform", "homebrew/cask/firefox"])
      assert.deepEqual(triageTargetFor(`brew:${name}`), {
        kind: "triage",
        type: "brew",
        target: name,
      });
  });

  it("leaves a probe untouched for other commands", () => {
    const p = probe();
    assert.equal(brewInstall(["npm", "install", "x"], p), false);
    assert.equal(brewInstall(["brew", "list"], p), false);
    assert.deepEqual(p, probe());
  });
});

describe("parseBrewInfo: a cask", () => {
  it("reads a cask when brew info lists no formula, so a cask is scored on its upstream repo", () => {
    const info = parseBrewInfo({
      formulae: [],
      casks: [
        {
          token: "tool",
          version: "1.2.3",
          homepage: "https://tool.example",
          url: "https://github.com/acme/tool/releases/download/v1.2.3/tool.dmg",
          deprecated: false,
          disabled: true,
        },
      ],
    });
    assert.deepEqual(info, {
      name: "tool",
      version: "1.2.3",
      homepage: "https://tool.example",
      repoUrl: "https://github.com/acme/tool",
      deprecated: false,
      disabled: true,
    });
  });

  it("still reads the formula first, and finds nothing in an empty answer", () => {
    const formula = parseBrewInfo({
      formulae: [{ name: "jq", homepage: "https://github.com/jqlang/jq" }],
      casks: [{ token: "other" }],
    });
    assert.equal(formula.name, "jq");
    assert.deepEqual(parseBrewInfo({ formulae: [], casks: [] }), {
      deprecated: false,
      disabled: false,
    });
  });
});
