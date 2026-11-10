import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditWorkflow } from "./gha-audit.js";

const HEAD_SHA = "${{ github.event.pull_request.head.sha }}";

describe("auditWorkflow", () => {
  it("flags unpinned action refs (tag/branch), not full-SHA pins", () => {
    const wf = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: tj-actions/changed-files@main",
      "      - uses: actions/setup-node@1d0ff469b7ec7b3cb9d8673fde0c81c44821de2a", // 40-hex SHA = pinned
      "      - uses: ./.github/actions/local", // local = exempt
    ].join("\n");
    const findings = auditWorkflow(wf, "ci.yml");
    const names = findings.map((f) => f.name);
    assert.ok(names.some((n) => n.includes("actions/checkout@v4")));
    assert.ok(names.some((n) => n.includes("tj-actions/changed-files@main")));
    assert.ok(!names.some((n) => n.includes("setup-node")), "full-SHA pin must not be flagged");
    assert.ok(!names.some((n) => n.includes("local")), "local action must be exempt");
    const checkoutFinding = findings.find((f) => f.name.includes("actions/checkout@v4"));
    assert.equal(checkoutFinding?.rule?.id, "CWE-1357");
    assert.equal(checkoutFinding?.severity, "medium");
  });

  it("flags pwn-request (pull_request_target + a checkout of the PR head)", () => {
    const wf =
      "on:\n  pull_request_target:\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n        with:\n          ref: " +
      HEAD_SHA +
      "\n      - run: npm test\n";
    const findings = auditWorkflow(wf, "danger.yml");
    const pwn = findings.find((f) => f.name.startsWith("pwn-request"));
    assert.ok(pwn);
    assert.equal(pwn?.severity, "high");
    assert.equal(pwn?.rule?.id, "OWASP-A08");
    assert.match(pwn?.detail ?? "", /a checkout of the pull request.s head/);
  });
});

describe("auditWorkflow: pull_request_target without PR code", () => {
  it("a plain checkout under pull_request_target is not a pwn request, but the default block is named", () => {
    // Under pull_request_target a checkout without `ref:` takes the BASE branch, not PR code.
    const wf =
      "on:\n  pull_request_target:\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n";
    const findings = auditWorkflow(wf, "label.yml");
    assert.ok(!findings.some((f) => f.name.startsWith("pwn-request")));
    const block = findings.find((f) => f.name.startsWith("pull_request_target default block"));
    assert.equal(block?.severity, "low");
    assert.match(block?.detail ?? "", /2026-12-02/);
  });

  it("clean workflow → no findings", () => {
    const wf =
      "on: push\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@1234567890123456789012345678901234567890\n";
    assert.deepEqual(auditWorkflow(wf, "ok.yml"), []);
  });
});

import { runGhaAudit } from "./gha-audit.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("runGhaAudit — unreadable workflow never yields a false-green pass", () => {
  it("emits a scanner-health warn (not 'all pinned' pass) when a workflow can't be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-gha-"));
    try {
      const wfDir = join(dir, ".github", "workflows");
      mkdirSync(wfDir, { recursive: true });
      // A clean, readable workflow…
      writeFileSync(
        join(wfDir, "ci.yml"),
        "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@1d0ff469b7ec7b3cb9d8673fde0c81c44821de2a\n",
      );
      // …and an UNREADABLE one (a directory named *.yml makes readFileSync throw EISDIR).
      mkdirSync(join(wfDir, "deploy.yml"));
      const results = runGhaAudit(dir);
      assert.ok(
        results.some((r) => r.status === "warn" && /could not read/.test(r.detail ?? "")),
        "must surface a scanner-health warn for the unreadable workflow",
      );
      assert.ok(
        !results.some((r) => r.status === "pass" && /all actions pinned/.test(r.detail ?? "")),
        "must NOT emit the blanket all-pinned pass when a workflow was not audited",
      );
    } finally {
      rmTemp(dir);
    }
  });
});
