/** Compiled CLI coverage for shared command-wrapper boundaries. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { repositoryGateFixture } from "./install-gate-repos-cli.test-support.js";
import {
  AMBIGUOUS_RUNNER_WRAPPERS,
  BENIGN_RUNNER_WRAPPERS,
  RUNNER_WRAPPERS,
} from "./install-gate-runner-wrappers.test-support.js";

const gate = repositoryGateFixture();

for (const wrapper of RUNNER_WRAPPERS) {
  it(`checks the real CLI decision behind ${wrapper}`, () => {
    for (const [child, expected] of [
      ["skills add https://foreign.example/owner/repo", "refuse"],
      ["skills add https://github.com/owner/repo", "repo"],
      ["skills add ./local/repo", "npm"],
      ["other skills add https://foreign.example/owner/repo", "npm"],
    ]) {
      const result = gate(`npm exec --package=skills -- ${wrapper} ${child}`);
      assert.equal(result.status, expected === "refuse" ? 2 : 0, result.stderr);
      if (expected === "refuse") {
        assert.match(result.stderr, /unsupported repository source/);
        assert.match(result.stderr, /foreign\.example/);
        assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE/);
      } else {
        assert.match(result.stderr, /FIXTURE_TRIAGE npm:skills/);
        if (expected === "repo") {
          assert.match(result.stderr, /FIXTURE_TRIAGE repo:https:\/\/github\.com\/owner\/repo\n/);
        } else assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE repo:/);
      }
    }
  });
}

for (const [wrapper, refusal] of AMBIGUOUS_RUNNER_WRAPPERS) {
  it(`refuses ambiguous syntax through the CLI: ${wrapper}`, () => {
    const result = gate(
      `npm exec --package=skills -- ${wrapper} add https://foreign.example/owner/repo`,
    );
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes(refusal), result.stderr);
    assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE/);
  });
}

for (const child of BENIGN_RUNNER_WRAPPERS) {
  it(`keeps a benign wrapped child allowed through the CLI: ${child}`, () => {
    const result = gate(
      `npm exec --package=skills -- ${child} add https://foreign.example/owner/repo`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /FIXTURE_TRIAGE npm:skills/);
    assert.doesNotMatch(result.stderr, /FIXTURE_TRIAGE repo:/);
  });
}
