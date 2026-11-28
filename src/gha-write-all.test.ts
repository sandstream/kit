/**
 * kit-research linkedin-batch-2026-11-27-vs-kit: a workflow with `permissions: write-all` was
 * reported only as `id-token: write`, one scope of many. The token can also push commits, publish
 * packages and edit pull requests. Fixture comments quote GitHub's guidance:
 * https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/controlling-permissions-for-github_token
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { auditWorkflow } from "./gha-audit.js";
import { auditWriteAll } from "./gha-write-all.js";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const steps = `    steps:\n      - uses: actions/checkout@${SHA}\n`;
const names = (wf: string): string[] => auditWriteAll(wf, "w.yml").map((r) => r.name);

describe("auditWriteAll", () => {
  it("names write-all at workflow level as write to every scope, and aims for read-only", () => {
    const wf = `on: push\npermissions: write-all\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n${steps}`;
    const rows = auditWriteAll(wf, "deploy.yml");
    assert.deepEqual(
      rows.map((r) => r.name),
      ["workflow-level permissions: write-all (deploy.yml)"],
    );
    assert.equal(rows[0]?.severity, "medium");
    assert.match(
      rows[0]?.detail ?? "",
      /write-all grants write to every scope \(contents, packages, actions,/,
    );
    assert.match(rows[0]?.suggestion ?? "", /read-only GITHUB_TOKEN/);
    assert.equal(rows[0]?.rule?.id, "CWE-250");
  });

  it("names write-all on a job, quoted or with a comment", () => {
    for (const v of ["write-all", "'write-all'", '"write-all"  # all of it']) {
      const wf = `on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    permissions: ${v}\n${steps}`;
      assert.deepEqual(names(wf), ["permissions: write-all on job release (w.yml)"], v);
    }
  });

  it("reports both levels when both set it", () => {
    const wf = `permissions: write-all\njobs:\n  a:\n    permissions: write-all\n${steps}  b:\n${steps}`;
    assert.deepEqual(names(wf), [
      "workflow-level permissions: write-all (w.yml)",
      "permissions: write-all on job a (w.yml)",
    ]);
  });

  it("does not flag read-all, {}, a scoped block, a comment, or no permissions block", () => {
    for (const p of [
      "permissions: read-all\n",
      "permissions: {}\n",
      "permissions:\n  contents: write\n  packages: write\n",
      "# permissions: write-all\n",
      "",
    ]) {
      assert.deepEqual(names(`on: push\n${p}jobs:\n  a:\n${steps}`), [], JSON.stringify(p));
    }
  });
});

describe("auditWorkflow includes the write-all rule", () => {
  it("reports write-all beside the id-token row it used to be reported as", () => {
    const wf = `on: push\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n${steps}`;
    const rows = auditWorkflow(wf, "w.yml").map((r) => r.name);
    assert.ok(rows.includes("workflow-level permissions: write-all (w.yml)"), rows.join("\n"));
    assert.ok(rows.includes("workflow-level id-token: write (w.yml)"), rows.join("\n"));
  });
});
