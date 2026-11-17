import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditIdToken, grantsIdToken, oidcUsers } from "./gha-id-token.js";
import { auditWorkflow } from "./gha-audit.js";

const SHA = "1234567890123456789012345678901234567890";

const names = (wf: string): string[] => auditIdToken(wf, "w.yml").map((f) => f.name);

describe("auditIdToken: workflow level", () => {
  it("flags id-token: write in the top-level permissions block", () => {
    const wf = [
      "on: push",
      "permissions:",
      "  contents: read",
      "  id-token: write",
      "jobs:",
      "  sign:",
      "    steps:",
      `      - uses: sigstore/cosign-installer@${SHA}`,
    ].join("\n");
    const rows = auditIdToken(wf, "w.yml");
    assert.deepEqual(
      rows.map((r) => r.name),
      ["workflow-level id-token: write (w.yml)"],
    );
    assert.equal(rows[0].severity, "medium");
    assert.equal(rows[0].rule?.id, "CWE-250");
  });

  it("flags write-all and the flow-map form at top level", () => {
    assert.equal(names("on: push\npermissions: write-all\njobs:\n  a:\n    steps: []\n").length, 1);
    assert.equal(
      names("on: push\npermissions: { contents: read, id-token: write }\njobs: {}\n").length,
      1,
    );
  });

  it("does not flag read-all, {} or id-token: read / none at top level", () => {
    for (const p of ["read-all", "{}", "\n  id-token: read", "\n  id-token: none"]) {
      assert.deepEqual(names(`on: push\npermissions: ${p}\njobs: {}\n`), [], p);
    }
  });

  it("a comment mentioning id-token: write does not count", () => {
    assert.deepEqual(names("on: push\npermissions:\n  contents: read # not id-token: write\n"), []);
  });
});

describe("auditIdToken: job level", () => {
  const job = (permLine: string, steps: string[]): string =>
    [
      "on: push",
      "permissions: {}",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      contents: read",
      `      ${permLine}`,
      "    steps:",
      ...steps.map((s) => `      ${s}`),
    ].join("\n");

  it("flags a job that grants id-token: write but never uses it", () => {
    const rows = auditIdToken(job("id-token: write", ["- run: npm test"]), "w.yml");
    assert.deepEqual(
      rows.map((r) => r.name),
      ["unused id-token: write on job build (w.yml)"],
    );
    assert.equal(rows[0].severity, "low");
  });

  it("passes each known OIDC user", () => {
    const users = [
      `- uses: aws-actions/configure-aws-credentials@${SHA}`,
      `- uses: google-github-actions/auth@${SHA}`,
      `- uses: Azure/login@${SHA}`,
      `- uses: sigstore/cosign-installer@${SHA}`,
      `- uses: actions/attest-build-provenance@${SHA}`,
      `- uses: pypa/gh-action-pypi-publish@${SHA}`,
      `- uses: ossf/scorecard-action@${SHA}`,
      "- run: npm publish --provenance --access public",
      "- run: cosign sign --yes img@sha256:abc",
      '- run: curl -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL"',
    ];
    for (const u of users) assert.deepEqual(names(job("id-token: write", [u])), [], u);
  });

  it("does not flag what it cannot see: a local action or a reusable workflow", () => {
    assert.deepEqual(names(job("id-token: write", ["- uses: ./.github/actions/release"])), []);
    const reusable = [
      "on: push",
      "jobs:",
      "  call:",
      "    permissions:",
      "      id-token: write",
      `    uses: org/repo/.github/workflows/release.yml@${SHA}`,
    ].join("\n");
    assert.deepEqual(names(reusable), []);
  });

  it("an OIDC word only in a comment is not a use", () => {
    const wf = job("id-token: write # cosign sign later", ["- run: echo hi # npm publish"]);
    assert.equal(names(wf).length, 1);
  });

  it("does not flag id-token: read on a job", () => {
    assert.deepEqual(names(job("id-token: read", ["- run: npm test"])), []);
  });

  it("an inherited grant is reported once, at workflow level", () => {
    const wf =
      "on: push\npermissions:\n  id-token: write\njobs:\n  a:\n    steps:\n      - run: make\n";
    assert.deepEqual(names(wf), ["workflow-level id-token: write (w.yml)"]);
  });

  it("is wired into auditWorkflow", () => {
    const rows = auditWorkflow(job("id-token: write", ["- run: npm test"]), "w.yml");
    assert.ok(rows.some((r) => r.name.startsWith("unused id-token: write")));
  });
});

describe("helpers", () => {
  it("grantsIdToken reads only the block at the given indent", () => {
    const lines = ["jobs:", "  a:", "    permissions:", "      id-token: write"];
    assert.equal(grantsIdToken(lines, 0), false);
    assert.equal(grantsIdToken(lines.slice(2), 4), true);
  });

  it("oidcUsers names what it found", () => {
    assert.deepEqual(oidcUsers(["    steps:", "      - run: npm publish"]), [
      "npm publish (trusted publishing / --provenance)",
    ]);
  });
});
