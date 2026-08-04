/**
 * The `policy agent-writes` row must actually reach the operator, and must describe the tree it was
 * given.
 *
 * Trap 5 from the enforcement arc, restated: `unknownPolicyEntries` had unit tests proving it
 * correct and no production caller, while four documents said `kit check` surfaced its result.
 * Measured before this row existed — a repo with
 *
 *   [policy.agent_writes]
 *   vercel = ["env-set"]        # typo: the real op is env_set
 *   sentry = ["resolve_issue"]  # not in the registry at the time
 *
 * produced a full `kit check` mentioning neither line, exit 0. So the assertions here are on
 * `checkSecurity()`'s OUTPUT, not only on the check function: a test over the check function alone
 * would have passed in exactly the state the measurement found.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPolicyAgentWrites } from "./check-policy-ops.js";
import { checkSecurity } from "./check-security.js";

function project(kitToml: string | null): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-policy-row-")));
  if (kitToml !== null) writeFileSync(join(dir, ".kit.toml"), kitToml);
  return dir;
}

const ROW = "policy agent-writes";

describe("the policy agent-writes row", () => {
  it("skips honestly when there is no config, and does NOT claim the check ran into a failure", async () => {
    const dir = project(null);
    try {
      const r = await checkPolicyAgentWrites(dir);
      assert.equal(r.status, "skip");
      // An absent config is not-applicable, not a scanner that could not run: marking it `didNotRun`
      // would fail the strict CI gate for every project that does not use kit's policy block.
      assert.notEqual(r.didNotRun, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when the block is absent but the config exists", async () => {
    const dir = project("version = 1\n");
    try {
      const r = await checkPolicyAgentWrites(dir);
      assert.equal(r.status, "skip");
      assert.match(r.detail, /not in use/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports didNotRun when the config exists but cannot be parsed", async () => {
    // The distinction the SecurityCheckResult type documents: this check was meant to run and could
    // not, which the strict gate must fail rather than read as green. An invalid `.kit.toml` is also
    // the one case where the policy in force is genuinely unknown.
    const dir = project("version = 1\n[policy.agent_writes\nvercel = [\n");
    try {
      const r = await checkPolicyAgentWrites(dir);
      assert.equal(r.status, "warn");
      assert.equal(r.didNotRun, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns on an op kit never asks about, and names the real ones", async () => {
    const dir = project('version = 1\n\n[policy.agent_writes]\nvercel = ["env-set"]\n');
    try {
      const r = await checkPolicyAgentWrites(dir);
      assert.equal(r.status, "warn");
      assert.match(r.detail, /env-set/, "the offending entry must be quoted back");
      // The operator's next question is "then what is it called?" — a finding that does not answer
      // it sends them to read source, which is how a typo survives a warning.
      assert.match(r.detail, /env_set/, "the real op names for that vendor must be listed");
      assert.ok(r.suggestion, "an actionable row needs the remediation");
      // And the consequence must be stated: the vendor is now DECLARED, so its real ops are refused.
      assert.match(r.detail, /refuses its real ops/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes and reports how much the policy refuses", async () => {
    const dir = project(
      'version = 1\n\n[policy.agent_writes]\nsupabase = ["scoped_key_mint"]\nsentry = ["resolve_issue"]\n',
    );
    try {
      const r = await checkPolicyAgentWrites(dir);
      assert.equal(r.status, "pass");
      assert.match(r.detail, /2 op\(s\) pre-approved/);
      // The count of refusals is the answer to "what is denied here?", which an operator otherwise
      // learns only from a refusal at the moment they hit one.
      assert.match(r.detail, /policy refuses 3 of the \d+ ops/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("describes the tree it was GIVEN, not the one the process sits in", async () => {
    // Discriminating by construction: A is clean, B has the typo. A build that resolved `.kit.toml`
    // from `process.cwd()` would return B's answer for A and make the two agree — the exact defect
    // the cwd-threading arc found in ten other dimensions.
    const clean = project('version = 1\n\n[policy.agent_writes]\nvercel = ["env_set"]\n');
    const typo = project('version = 1\n\n[policy.agent_writes]\nvercel = ["env-set"]\n');
    const prev = process.cwd();
    try {
      process.chdir(typo);
      const a = await checkPolicyAgentWrites(clean);
      const b = await checkPolicyAgentWrites(typo);
      assert.equal(
        a.status,
        "pass",
        `sitting in the typo'd tree must not change A's verdict: ${a.detail}`,
      );
      assert.equal(b.status, "warn");
      assert.notEqual(a.status, b.status, "the two trees must not answer the same");
    } finally {
      process.chdir(prev);
      rmSync(clean, { recursive: true, force: true });
      rmSync(typo, { recursive: true, force: true });
    }
  });

  it("is IN checkSecurity's results — the wiring, not the function", async () => {
    // This is the assertion that would have failed in the measured state. It fails if the push in
    // `checkSecurity` is removed, which no test over `checkPolicyAgentWrites` can do.
    const dir = project('version = 1\n\n[policy.agent_writes]\nvercel = ["env-set"]\n');
    try {
      const results = await checkSecurity(dir);
      const row = results.find((r) => r.name === ROW);
      assert.ok(row, `checkSecurity must include the "${ROW}" row — every surface calls it`);
      assert.equal(row.status, "warn");
      assert.match(row.detail, /env-set/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
