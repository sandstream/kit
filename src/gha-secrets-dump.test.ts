/**
 * kit-research wfx-github-actions-campaign-vs-kit: a workflow step with `toJSON(secrets)` in its
 * env, the shape pushed into thousands of repositories in November 2026, produced no row in kit's
 * workflow audit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { auditWorkflow } from "./gha-audit.js";
import { auditSecretsDump } from "./gha-secrets-dump.js";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const wf = (step: string) =>
  `on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA}\n${step}`;
const DUMP_STEP =
  "      - name: Restore cache ab12\n        env:\n          ALL: ${{ toJSON(secrets) }}\n          VARS: ${{ toJSON(vars) }}\n        run: echo placeholder\n";

describe("auditSecretsDump", () => {
  it("flags a step that takes every secret, with its line", () => {
    const rows = auditSecretsDump(wf(DUMP_STEP), "ci.yml");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "warn");
    assert.equal(rows[0]?.name, "workflow step takes every secret (ci.yml)");
    assert.match(rows[0]?.detail ?? "", /toJSON\(secrets\) on line 11/);
  });

  it("matches other spellings and lists every line", () => {
    const step =
      "      - run: echo\n        env:\n          A: ${{ tojson( secrets ) }}\n          B: ${{toJson(secrets)}}\n";
    assert.match(auditSecretsDump(wf(step), "w.yml")[0]?.detail ?? "", /on lines 11, 12/);
  });

  it("leaves a named secret, toJSON(vars) and a comment alone", () => {
    const step =
      "      - run: echo\n        env:\n          T: ${{ secrets.NPM_TOKEN }}\n          V: ${{ toJSON(vars) }}\n          # never use toJSON(secrets) here\n          G: ${{ toJSON(github.event) }}\n";
    assert.deepEqual(auditSecretsDump(wf(step), "w.yml"), []);
  });
});

describe("kit's workflow audit includes it", () => {
  it("reports the row from auditWorkflow", () => {
    const rows = auditWorkflow(wf(DUMP_STEP), "ci.yml");
    assert.ok(rows.some((r) => r.name === "workflow step takes every secret (ci.yml)"));
  });
});
