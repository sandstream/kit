import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  auditSkippableGates,
  computedSkip,
  gatesPullRequests,
  parseJobs,
} from "./gha-skip-gate.js";

/** The shape the rule exists for: affected-detection decides whether the tests run at all. */
const AFFECTED = `name: CI
on:
  pull_request:
    branches: [main]
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      server: \${{ steps.filter.outputs.server }}
    steps:
      - id: filter
        run: echo "server=true" >> "$GITHUB_OUTPUT"
  test:
    needs: changes
    if: needs.changes.outputs.server == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`;

const AGGREGATED =
  AFFECTED +
  `  gate:
    needs: [changes, test]
    if: \${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - run: test "\${{ needs.test.result }}" = "success"
`;

describe("parseJobs", () => {
  it("reads job ids, job-level if and needs in every spelling", () => {
    const jobs = parseJobs(AGGREGATED);
    assert.deepEqual(
      jobs.map((j) => j.id),
      ["changes", "test", "lint", "gate"],
    );
    const test = jobs.find((j) => j.id === "test");
    assert.equal(test?.cond, "needs.changes.outputs.server == 'true'");
    assert.deepEqual(test?.needs, ["changes"]);
    assert.deepEqual(jobs.find((j) => j.id === "gate")?.needs, ["changes", "test"]);
    assert.equal(jobs.find((j) => j.id === "lint")?.cond, "");
  });

  it("ignores a step-level if and reads a block list of needs", () => {
    const text = `on: pull_request
jobs:
  a:
    runs-on: x
    steps:
      - if: needs.b.outputs.c == 'true'
        run: echo
  d:
    needs:
      - a
      - "b"
    runs-on: x
`;
    const jobs = parseJobs(text);
    assert.equal(jobs.find((j) => j.id === "a")?.cond, "");
    assert.deepEqual(jobs.find((j) => j.id === "d")?.needs, ["a", "b"]);
  });
});

describe("gatesPullRequests / computedSkip", () => {
  it("knows which triggers gate a merge", () => {
    assert.equal(gatesPullRequests("on: pull_request\njobs: {}\n"), true);
    assert.equal(gatesPullRequests("on: [push, merge_group]\n"), true);
    assert.equal(gatesPullRequests("on:\n  push:\n    branches: [main]\njobs:\n"), false);
    assert.equal(gatesPullRequests("name: x\n"), false);
  });

  it("treats only a condition computed by another job as a runtime skip", () => {
    assert.equal(computedSkip("needs.changes.outputs.server == 'true'"), true);
    assert.equal(computedSkip("github.event_name == 'push'"), false);
    assert.equal(computedSkip(""), false);
  });
});

describe("auditSkippableGates", () => {
  it("flags an affected-only test job that nothing aggregates", () => {
    const out = auditSkippableGates(AFFECTED, "ci.yml");
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "skippable gate test (ci.yml)");
    assert.equal(out[0].status, "warn");
    assert.match(out[0].detail, /skipped job passes a required check/);
  });

  it("is quiet once an always() aggregator checks the job's result", () => {
    assert.deepEqual(auditSkippableGates(AGGREGATED, "ci.yml"), []);
  });

  it("does not count an aggregator that never looks at the result", () => {
    const blind = AGGREGATED.replace('test "${{ needs.test.result }}" = "success"', "echo done");
    assert.equal(auditSkippableGates(blind, "ci.yml").length, 1);
  });

  it("ignores workflows that never gate a pull request", () => {
    const pushOnly = AFFECTED.replace("  pull_request:\n    branches: [main]", "  push:");
    assert.deepEqual(auditSkippableGates(pushOnly, "ci.yml"), []);
  });

  it("reads CRLF workflows the same", () => {
    assert.equal(auditSkippableGates(AFFECTED.replace(/\n/g, "\r\n"), "ci.yml").length, 1);
  });

  it("finds nothing in kit's own workflows", () => {
    const dir = join(import.meta.dirname, "..", ".github", "workflows");
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      assert.deepEqual(auditSkippableGates(readFileSync(join(dir, f), "utf8"), f), [], f);
    }
  });
});
