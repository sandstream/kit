import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gemInstall, type GemProbe } from "./install-gate-gem.js";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import { gateInstall, triageTargetFor, type GateDeps } from "./triage-gate.js";
import type { TriageType } from "./triage.js";

const probe = (): GemProbe => ({ isInstall: false, refs: [], unverifiable: [] });

/** Triage stub: records each call and passes every gem except `blocked`. */
function stubDeps(calls: string[], blocked = "strutil-core"): GateDeps {
  return {
    runTriage: async (type: TriageType, target: string) => {
      calls.push(`${type} ${target}`);
      const passed = !target.startsWith(blocked);
      return { type, target, passed, output: passed ? "TRIAGE PASSED" : "  x CRITICAL: bad" };
    },
  };
}

describe("install gate: gem install and bundle add (kit-research strutil-core-gem-worm-vs-kit)", () => {
  const refs: Array<[string, string[]]> = [
    ["gem install left-pad", ["gem:left-pad"]],
    ["gem i rails", ["gem:rails"]],
    ["gem install strutil-core -v 1.0.1", ["gem:strutil-core@1.0.1"]],
    ["gem install strutil-core --version=1.0.1", ["gem:strutil-core@1.0.1"]],
    ["gem install strutil-core -v1.0.1", ["gem:strutil-core@1.0.1"]],
    ["gem install nokogiri:1.16.0", ["gem:nokogiri@1.16.0"]],
    ["gem install a b --no-document", ["gem:a", "gem:b"]],
    ["sudo gem install rake", ["gem:rake"]],
    ["gem install native -- --with-opt-dir=/x", ["gem:native"]],
    ["bundle add left-pad", ["gem:left-pad"]],
    ["bundle add rails --version 7.1.3 --group development", ["gem:rails@7.1.3"]],
    ["bundle add rspec -g test", ["gem:rspec"]],
    ['sh -c "gem install left-pad"', ["gem:left-pad"]],
  ];
  for (const [command, expected] of refs) {
    it(`gates ${command}`, () => {
      const parsed = parseInstallCommand(command);
      assert.equal(parsed.isInstall, true);
      assert.deepEqual(parsed.refs, expected);
      assert.deepEqual(parsed.unverifiable, []);
    });
  }

  const refused = [
    "gem install --source https://gems.example foo",
    "gem install foo -s https://gems.example",
    "gem install foo --clear-sources",
    "gem install -g gem.deps.rb",
    "gem install foo --pre",
    'gem install rails -v "~> 7.1"',
    "bundle add foo --git https://example.com/foo.git",
    "bundle add foo --github acme/foo",
    'bundle add rails --version "~> 7.1"',
    "gem install 'bad name'",
  ];
  for (const command of refused) {
    it(`refuses ${command}`, async () => {
      const verdict = await decideBashGate(command, stubDeps([]));
      assert.equal(verdict.block, true);
      assert.match(verdict.reason, /fail-closed/);
    });
  }

  const ignored = [
    "gem list",
    "gem --version",
    "gem install ./pkg/mine-1.0.0.gem",
    "gem install mine-1.0.0.gem",
    "bundle exec rake",
    "bundle add",
    "gem install",
  ];
  for (const command of ignored) {
    it(`is not a registry install: ${command}`, () => {
      const parsed = parseInstallCommand(command);
      assert.deepEqual(parsed.refs, []);
      assert.deepEqual(parsed.unverifiable, []);
    });
  }
});

describe("install gate: gem triage decides, as for npm", () => {
  it("blocks a gem whose triage does not pass, as npm does", async () => {
    const calls: string[] = [];
    const verdict = await decideBashGate("gem install strutil-core -v 1.0.1", stubDeps(calls));
    assert.equal(verdict.block, true);
    assert.deepEqual(calls, ["gem strutil-core@1.0.1"]);
    assert.match(verdict.reason, /triage did not pass \(gem strutil-core@1\.0\.1\)/);
  });

  it("allows a gem whose triage passes", async () => {
    const calls: string[] = [];
    const verdict = await decideBashGate("bundle add rails", stubDeps(calls));
    assert.equal(verdict.block, false);
    assert.deepEqual(calls, ["gem rails"]);
  });

  it("maps a gem: ref to gem triage, not to the untriageable fallback", async () => {
    assert.deepEqual(triageTargetFor("gem:rails@7.1.3"), {
      kind: "triage",
      type: "gem",
      target: "rails@7.1.3",
    });
    const v = await gateInstall("gem:rails", stubDeps([]));
    assert.equal(v.decision, "pass");
  });

  it("leaves a probe untouched for other commands", () => {
    const p = probe();
    assert.equal(gemInstall(["npm", "install", "x"], p), false);
    assert.deepEqual(p, probe());
  });
});
