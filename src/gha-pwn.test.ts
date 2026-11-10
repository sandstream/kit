import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pwnRequest, stripComments, workflowTriggers } from "./gha-pwn.js";

const SHA = "08eba0b27e820071cde6df949e0beb9ba4906955";
const job = (steps: string) => `jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;

/** The six workflows measured in kit-research `github-pull-request-target-default-block-vs-kit`. */
const SHAPES = {
  labeler: `on: pull_request_target\n${job("      - uses: actions/labeler@" + SHA + "\n")}`,
  baseCheckout: `on: pull_request_target\n${job(`      - uses: actions/checkout@${SHA}\n      - run: echo base only\n`)}`,
  unsafeHead: `on: pull_request_target\n${job(
    `      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          allow-unsafe-pr-checkout: true\n      - run: npm test\n`,
  )}`,
  ghPrCheckout: `on: pull_request_target\n${job("      - run: gh pr checkout ${{ github.event.number }} && npm ci && npm test\n")}`,
  workflowRun: `on:\n  workflow_run:\n    workflows: [ci]\n    types: [completed]\n${job(
    `      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ github.event.workflow_run.head_sha }}\n      - run: npm test\n`,
  )}`,
  commentOnly: `# Never switch this to pull_request_target.\non: push\n${job(`      - uses: actions/checkout@${SHA}\n      - run: npm test\n`)}`,
};

describe("pwnRequest on the six measured workflows", () => {
  it("passes the three safe ones", () => {
    assert.equal(pwnRequest(SHAPES.labeler), null);
    assert.equal(pwnRequest(SHAPES.baseCheckout), null, "a plain checkout takes the base branch");
    assert.equal(pwnRequest(SHAPES.commentOnly), null, "a comment is not a trigger");
  });

  it("flags the three pwn requests and names each shape", () => {
    assert.match(pwnRequest(SHAPES.unsafeHead)!.shapes.join(), /allow-unsafe-pr-checkout/);
    assert.match(pwnRequest(SHAPES.ghPrCheckout)!.shapes.join(), /gh pr checkout/);
    const wr = pwnRequest(SHAPES.workflowRun)!;
    assert.equal(wr.trigger, "workflow_run");
    assert.match(wr.shapes.join(), /triggering run.s head/);
  });

  it("does not flag PR-code shapes under a trigger without secrets", () => {
    assert.equal(
      pwnRequest(SHAPES.ghPrCheckout.replace("pull_request_target", "pull_request")),
      null,
    );
  });

  it("flags issue_comment with a fetch of pull/N/head", () => {
    const wf = `on:\n  issue_comment:\n    types: [created]\n${job("      - run: git fetch origin pull/${{ github.event.issue.number }}/head:pr && git checkout pr && make\n")}`;
    assert.match(pwnRequest(wf)!.shapes.join(), /pull\/N\/head/);
  });
});

describe("workflowTriggers", () => {
  it("reads scalar, flow-list, block-mapping and block-list forms", () => {
    assert.deepEqual(workflowTriggers("on: push\n"), ["push"]);
    assert.deepEqual(workflowTriggers("on: [push, 'pull_request_target']\n"), [
      "push",
      "pull_request_target",
    ]);
    assert.deepEqual(
      workflowTriggers(
        "on:\n  pull_request_target:\n    types: [opened]\n  push:\n    branches: [main]\njobs: {}\n",
      ),
      ["pull_request_target", "push"],
    );
    assert.deepEqual(workflowTriggers('"on":\n  - push\n  - workflow_run\n'), [
      "push",
      "workflow_run",
    ]);
  });
  it("ignores a commented-out trigger and a file with no on:", () => {
    assert.deepEqual(workflowTriggers("on:\n  # pull_request_target:\n  push:\n"), ["push"]);
    assert.deepEqual(workflowTriggers("jobs: {}\n"), []);
  });
});

describe("stripComments", () => {
  it("drops # comments but keeps a # inside quotes or a value", () => {
    assert.equal(stripComments("run: echo hi # note"), "run: echo hi");
    assert.equal(stripComments("# whole line"), "");
    assert.equal(stripComments('run: echo "a # b"'), 'run: echo "a # b"');
    assert.equal(stripComments("url: https://x.test/a#frag"), "url: https://x.test/a#frag");
  });
});
