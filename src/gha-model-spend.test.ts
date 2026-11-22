/**
 * kit-research owasp-xpsd-vs-kit: a workflow that grants `copilot-requests: write` to every job
 * produced no row in kit's workflow audit. The permission lets a job spend the organisation's
 * model budget and send what it reads to a model.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { auditWorkflow } from "./gha-audit.js";
import { auditModelSpend, topLevelPermissions } from "./gha-model-spend.js";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const job = (perms = "") =>
  `jobs:\n  a:\n    runs-on: ubuntu-latest\n${perms}    steps:\n      - uses: actions/checkout@${SHA}\n`;

describe("auditModelSpend", () => {
  it("flags copilot-requests: write at workflow level (the Xpsd README workflow)", () => {
    const wf = `on: push\npermissions:\n  contents: read\n  security-events: write\n  copilot-requests: write   # built-in token\n${job()}`;
    const rows = auditModelSpend(wf, "reachability.yml");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "warn");
    assert.match(
      rows[0]?.name ?? "",
      /workflow-level copilot-requests: write \(reachability\.yml\)/,
    );
    assert.match(rows[0]?.detail ?? "", /Copilot spend/);
  });

  it("flags models: read, and the inline form", () => {
    assert.equal(auditModelSpend(`permissions:\n  models: read\n${job()}`, "w.yml").length, 1);
    const inline = `permissions: { contents: read, copilot-requests: write }\n${job()}`;
    assert.equal(auditModelSpend(inline, "w.yml").length, 1);
  });

  it("does not flag the grant on one job, a comment, or a workflow without it", () => {
    const onJob = `permissions:\n  contents: read\n${job("    permissions:\n      copilot-requests: write\n")}`;
    assert.deepEqual(auditModelSpend(onJob, "w.yml"), []);
    const comment = `permissions:\n  contents: read\n  # copilot-requests: write\n${job()}`;
    assert.deepEqual(auditModelSpend(comment, "w.yml"), []);
    assert.deepEqual(auditModelSpend(`permissions:\n  contents: read\n${job()}`, "w.yml"), []);
    assert.deepEqual(auditModelSpend(job(), "w.yml"), []);
  });

  it("topLevelPermissions stops at the next top-level key", () => {
    const wf = `permissions:\n  contents: read\nenv:\n  copilot-requests: write\n${job()}`;
    assert.equal(topLevelPermissions(wf).includes("copilot-requests"), false);
  });
});

describe("auditWorkflow includes the rule", () => {
  it("reports it beside the other workflow findings", () => {
    const wf = `on: push\npermissions:\n  copilot-requests: write\n${job()}`;
    const names = auditWorkflow(wf, "w.yml").map((r) => r.name);
    assert.ok(names.includes("workflow-level copilot-requests: write (w.yml)"), names.join("; "));
  });
});
