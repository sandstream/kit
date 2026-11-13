/** Repository decisions follow the resolved wrapper child, never a later argument. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import {
  AMBIGUOUS_RUNNER_WRAPPERS,
  BENIGN_RUNNER_WRAPPERS,
  RUNNER_WRAPPERS,
} from "./install-gate-runner-wrappers.test-support.js";

for (const wrapper of RUNNER_WRAPPERS) {
  it(`follows the repository installer behind ${wrapper}`, async () => {
    for (const runner of ["npm exec --package=skills --", "npx --package=skills --"]) {
      for (const [source, repo] of [
        ["https://foreign.example/owner/repo", false],
        ["https://github.com/owner/repo", true],
        ["./local/repo", false],
      ] as const) {
        const command = `${runner} ${wrapper} skills add ${source}`;
        const blocked = source.includes("foreign.example");
        const parsed = parseInstallCommand(command);
        assert.deepEqual(parsed.refs, repo ? ["npm:skills", "github:owner/repo"] : ["npm:skills"]);
        assert.deepEqual(parsed.unverifiable, blocked ? [`repo-source:${source}`] : []);
        const checked: string[] = [];
        const verdict = await decideBashGate(command, {
          runTriage: async (type, target) => {
            checked.push(`${type}:${target}`);
            return { type, target, passed: true, output: "TRIAGE PASSED" };
          },
        });
        assert.equal(verdict.block, blocked, command);
        assert.deepEqual(
          checked,
          blocked
            ? []
            : repo
              ? ["npm:skills", "repo:https://github.com/owner/repo"]
              : ["npm:skills"],
        );
      }
      const benign = `${runner} ${wrapper} other skills add https://foreign.example/owner/repo`;
      assert.deepEqual(parseInstallCommand(benign).unverifiable, []);
      assert.deepEqual(parseInstallCommand(benign).refs, ["npm:skills"]);
    }
  });
}

for (const [wrapper, refusal] of AMBIGUOUS_RUNNER_WRAPPERS) {
  it(`refuses ambiguous runner wrapper syntax: ${wrapper}`, async () => {
    const command = `npm exec --package=skills -- ${wrapper} add https://foreign.example/owner/repo`;
    assert.deepEqual(parseInstallCommand(command).unverifiable, [refusal]);
    const verdict = await decideBashGate(command, {
      runTriage: async () => assert.fail("an ambiguous child must not reach triage"),
    });
    assert.equal(verdict.block, true);
    assert.deepEqual(verdict.checked, []);
    assert.ok(verdict.reason.includes(refusal));
  });
}

for (const child of BENIGN_RUNNER_WRAPPERS) {
  it(`keeps wrapper values and child arguments out of command detection: ${child}`, async () => {
    const command = `npm exec --package=skills -- ${child} add https://foreign.example/owner/repo`;
    const parsed = parseInstallCommand(command);
    assert.deepEqual(parsed.refs, ["npm:skills"]);
    assert.deepEqual(parsed.unverifiable, []);
    const verdict = await decideBashGate(command, {
      runTriage: async (type, target) => {
        assert.equal(type, "npm");
        assert.equal(target, "skills");
        return { type, target, passed: true, output: "TRIAGE PASSED" };
      },
    });
    assert.equal(verdict.block, false);
    assert.deepEqual(
      verdict.checked.map(({ tool }) => tool),
      ["npm:skills"],
    );
  });
}
