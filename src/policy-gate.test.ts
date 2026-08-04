/**
 * `[policy.agent_writes]` is now enforced. These tests are organised around the five traps ROADMAP
 * named for this arc, because those are the ways this specific control fails OPEN:
 *
 *   1. an empty list means DENY, not allow;
 *   2. absent-vendor and present-but-empty must stay distinguishable;
 *   3. the op vocabulary needs one source, and an unknown op must be surfaced;
 *   4. policy may only NARROW — never grant past elevation;
 *   5. every branch needs a behavioural test that fails when the wiring is removed.
 *
 * Trap 5 is why the second half of this file exercises `propagate()` rather than only the pure
 * predicate: the original defect was that `checkPolicy` had unit tests proving the decision
 * function correct while nothing called it. Tests over a decision function are not evidence of a
 * working control.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  policyDecision,
  policyRefuses,
  unknownPolicyEntries,
  knownPolicyOps,
  POLICY_OPS,
} from "./policy-gate.js";
import { propagate, ALL_TARGETS } from "./secrets-propagate.js";
import type { PolicyConfig } from "./config.js";

describe("trap 1 — an empty vendor list denies", () => {
  it("`stripe = []` refuses the op, matching kit's own config comment", () => {
    // An empty array is TRUTHY in JS, so a `!allowed` reading would fall through to "no rule".
    const policy: PolicyConfig = { agent_writes: { vercel: [] } };
    const d = policyDecision(policy, "vercel", "env_set");
    assert.equal(d.state, "denied");
    assert.match(d.reason, /empty/, `the reason must say why: ${d.reason}`);
  });

  it("a non-empty list still denies an op that is not in it", () => {
    const policy: PolicyConfig = { agent_writes: { vercel: ["trigger_deploy"] } };
    assert.equal(policyDecision(policy, "vercel", "env_set").state, "denied");
  });

  it("a malformed entry fails CLOSED rather than reading as 'no rule'", () => {
    // `vercel = "env_set"` — a string, not a list. In an access-control block, guessing is the
    // fail-open reading.
    const policy = { agent_writes: { vercel: "env_set" } } as unknown as PolicyConfig;
    const d = policyDecision(policy, "vercel", "env_set");
    assert.equal(d.state, "denied");
    assert.match(d.reason, /not a list/);
  });
});

describe("trap 2 — absent vendor and empty vendor are different states", () => {
  it("a declared-but-empty vendor DENIES while an undeclared vendor does not", () => {
    const policy: PolicyConfig = { agent_writes: { vercel: [] } };
    const declared = policyDecision(policy, "vercel", "env_set");
    const undeclared = policyDecision(policy, "github", "env_set");

    // The pair is the assertion. Collapsing these into a boolean is the mistake ROADMAP named:
    // one means "configured to refuse", the other means "unconfigured".
    assert.equal(declared.state, "denied");
    assert.equal(undeclared.state, "unconfigured");
    assert.notEqual(declared.state, undeclared.state);
  });

  it("declaring one vendor does not silently break the others", () => {
    // Opting in is PER VENDOR. If `unconfigured` denied, adding a vercel rule would take github
    // offline — an outage disguised as a security control.
    const policy: PolicyConfig = { agent_writes: { vercel: ["env_set"] } };
    assert.equal(policyRefuses(policy, "github", "env_set"), null);
  });

  it("no block at all is inert, and distinct from both", () => {
    assert.equal(policyDecision(undefined, "vercel", "env_set").state, "inert");
    assert.equal(policyDecision({}, "vercel", "env_set").state, "inert");
    assert.equal(policyDecision({ agent_writes: {} }, "vercel", "env_set").state, "inert");
  });

  it("a vendor named like an Object.prototype member is not a rule", () => {
    // `constructor` would resolve to a truthy inherited function without the own-property guard.
    const policy: PolicyConfig = { agent_writes: { vercel: ["env_set"] } };
    for (const hostile of ["constructor", "toString", "__proto__"]) {
      assert.equal(
        policyDecision(policy, hostile, "env_set").state,
        "unconfigured",
        `${hostile} must not resolve to an inherited member`,
      );
    }
  });
});

describe("trap 3 — one op vocabulary, and unknown entries are surfaced", () => {
  it("every gated (vendor, op) pair has a registry entry", () => {
    // The gate asks about `env_set` for all six propagation targets. If a target is added to
    // ALL_TARGETS without a registry row, the operator cannot pre-approve it and would have no
    // way to find out why.
    const known = knownPolicyOps();
    const missing = ALL_TARGETS.filter((t) => !known.has(`${t}:env_set`));
    assert.deepEqual(missing, [], `propagation targets missing from POLICY_OPS: ${missing}`);
  });

  it("a typo'd op is reported rather than silently ignored", () => {
    // The operator believes `env-set` grants something. It never will — kit only ever asks about
    // `env_set` — so this must surface.
    const policy: PolicyConfig = { agent_writes: { vercel: ["env-set"] } };
    assert.deepEqual(unknownPolicyEntries(policy), [{ vendor: "vercel", op: "env-set" }]);
  });

  it("a correctly spelled op is not reported", () => {
    const policy: PolicyConfig = { agent_writes: { vercel: ["env_set"] } };
    assert.deepEqual(unknownPolicyEntries(policy), []);
  });

  it("the registry is frozen — it is a contract, not a scratch list", () => {
    assert.throws(() => {
      (POLICY_OPS as unknown as { push: (x: unknown) => void }).push({
        vendor: "x",
        op: "y",
        description: "z",
      });
    });
  });
});

describe("trap 4 — policy narrows, it never grants", () => {
  it("`policyRefuses` returns null for approved — approval is not a grant signal", () => {
    // The enforcement point only ever asks "does policy refuse?". There is deliberately no
    // "policy approved, so skip the other gates" path: this block is UNSIGNED config, and anyone
    // who can edit the repo — including an agent — could otherwise self-approve.
    const policy: PolicyConfig = { agent_writes: { vercel: ["env_set"] } };
    assert.equal(policyDecision(policy, "vercel", "env_set").state, "approved");
    assert.equal(policyRefuses(policy, "vercel", "env_set"), null);
  });

  it("an approval says out loud that it does not satisfy the other gates", () => {
    const policy: PolicyConfig = { agent_writes: { vercel: ["env_set"] } };
    const d = policyDecision(policy, "vercel", "env_set");
    assert.match(d.reason, /does NOT satisfy elevation, read-only or approval/);
  });

  it("the three non-denying states are indistinguishable to the enforcement point", () => {
    // inert / unconfigured / approved must all mean "policy has no objection" and nothing more.
    const approved: PolicyConfig = { agent_writes: { vercel: ["env_set"] } };
    assert.equal(policyRefuses(undefined, "vercel", "env_set"), null);
    assert.equal(policyRefuses(approved, "github", "env_set"), null);
    assert.equal(policyRefuses(approved, "vercel", "env_set"), null);
  });
});

describe("trap 5 — the control is WIRED, not merely correct", () => {
  // The original defect: `checkPolicy` was correct, tested, and had no caller. So these go through
  // `propagate()`, the real choke point, and assert the adapter never ran.

  it("a refused target never reaches its adapter", async () => {
    const policy: PolicyConfig = { agent_writes: { vercel: [] } };
    // No vercel CLI is installed here; if the adapter ran, the failure detail would come from the
    // spawn (ENOENT / "not found"), not from the policy. The detail is the discriminator.
    const results = await propagate("API_KEY", "s3cret", ["vercel"], { policy });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.ok, false);
    assert.match(results[0]!.detail, /refused by \[policy\.agent_writes\]/);
    assert.equal(results[0]!.valueInArgv, false, "a refused write must not have exposed the value");
  });

  it("the secret value is not echoed in a refusal", async () => {
    const policy: PolicyConfig = { agent_writes: { fly: [] } };
    const results = await propagate("API_KEY", "sup3r-s3cret-value", ["fly"], { policy });
    assert.doesNotMatch(
      JSON.stringify(results),
      /sup3r-s3cret-value/,
      "a policy refusal must not leak the value it refused to write",
    );
  });

  it("only the refused target is stopped — the others are unaffected", async () => {
    // github is undeclared (unconfigured) and must proceed to its adapter, where it fails for an
    // ordinary reason. Same call, two different failure CAUSES: that pair is what proves the gate
    // is selective rather than a blanket stop.
    const policy: PolicyConfig = { agent_writes: { vercel: [] } };
    const results = await propagate("API_KEY", "s3cret", ["vercel", "github"], { policy });
    const byTarget = new Map(results.map((r) => [r.target, r]));
    assert.match(byTarget.get("vercel")!.detail, /refused by \[policy\.agent_writes\]/);
    assert.doesNotMatch(
      byTarget.get("github")!.detail,
      /refused by \[policy\.agent_writes\]/,
      "an undeclared vendor must not be refused by policy",
    );
  });

  it("omitting the policy leaves behaviour exactly as before", async () => {
    const results = await propagate("API_KEY", "s3cret", ["vercel"], {});
    assert.doesNotMatch(
      results[0]!.detail,
      /refused by \[policy\.agent_writes\]/,
      "no policy block must mean no policy gate",
    );
  });
});
