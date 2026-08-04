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

import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enforcePolicy,
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

describe("enforced decisions reach the audit trail", () => {
  /**
   * The half of trap 3 that was still missing: a refusal appeared in the command's output and
   * nowhere else. `enforcePolicy` is the audited enforcement point; `policyDecision` stays pure.
   *
   * Each test asserts on the CONTENTS of the governed project's `.kit-audit.jsonl`, and the two
   * "no policy opinion" states assert the file was not created at all — silence has to be
   * verified, or "we audit decisions" quietly becomes "we audit some decisions".
   */
  function project(): string {
    return mkdtempSync(join(tmpdir(), "kit-policy-audit-"));
  }

  function auditLines(dir: string): Record<string, unknown>[] {
    const f = join(dir, ".kit-audit.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("a DENIAL is recorded with the vendor, op, state and policy hash", async () => {
    const dir = project();
    try {
      const policy: PolicyConfig = { agent_writes: { vercel: [] } };
      const refusal = await enforcePolicy(policy, "vercel", "env_set", { cwd: dir });
      assert.notEqual(refusal, null, "the denial must still be returned, not just logged");

      const rows = auditLines(dir).filter((r) => r.operation === "policy-check");
      assert.equal(rows.length, 1, "exactly one policy-check entry");
      const meta = rows[0]!.metadata as Record<string, unknown>;
      assert.equal(rows[0]!.success, false, "a denial is not a successful check");
      assert.equal(meta.vendor, "vercel");
      assert.equal(meta.op, "env_set");
      assert.equal(meta.policy_state, "denied");
      assert.equal(typeof meta.policy_hash, "string", "the hash correlates the entry to a config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an APPROVAL is recorded too — the trail covers grants, not only refusals", async () => {
    const dir = project();
    try {
      const policy: PolicyConfig = { agent_writes: { vercel: ["env_set"] } };
      const refusal = await enforcePolicy(policy, "vercel", "env_set", { cwd: dir });
      assert.equal(refusal, null, "an approval must not refuse");

      const rows = auditLines(dir).filter((r) => r.operation === "policy-check");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.success, true);
      assert.equal((rows[0]!.metadata as Record<string, unknown>).policy_state, "approved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inert and unconfigured write NOTHING — absence of an opinion is not a decision", async () => {
    const dir = project();
    try {
      // No block at all, then a block that says nothing about this vendor. Recording these would
      // put a line in every repo that does not use the feature, burying the two that matter.
      await enforcePolicy(undefined, "vercel", "env_set", { cwd: dir });
      await enforcePolicy({ agent_writes: { github: ["env_set"] } }, "vercel", "env_set", {
        cwd: dir,
      });
      assert.deepEqual(auditLines(dir), [], "no policy opinion must leave no policy entry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the audit lands in the GOVERNED project, not the process's directory", async () => {
    const governed = project();
    const elsewhere = project();
    const prev = process.cwd();
    try {
      process.chdir(elsewhere);
      await enforcePolicy({ agent_writes: { vercel: [] } }, "vercel", "env_set", { cwd: governed });
      assert.equal(auditLines(governed).length, 1, "evidence belongs to the governed project");
      assert.deepEqual(auditLines(elsewhere), [], "the process's own tree must not collect it");
    } finally {
      process.chdir(prev);
      rmSync(governed, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("propagate's refusal is audited end to end", async () => {
    // Trap 5 again, one level up: the audit has to happen on the REAL path, not only when
    // `enforcePolicy` is called directly from a test.
    const dir = project();
    const prev = process.cwd();
    try {
      process.chdir(dir);
      const results = await propagate("API_KEY", "s3cret", ["vercel"], {
        policy: { agent_writes: { vercel: [] } },
        cwd: dir,
      });
      assert.match(results[0]!.detail, /refused by \[policy\.agent_writes\]/);
      const rows = auditLines(dir).filter((r) => r.operation === "policy-check");
      assert.equal(rows.length, 1, "the refusal that stopped the write must be on record");
      assert.doesNotMatch(
        JSON.stringify(rows),
        /s3cret/,
        "the audit entry must not carry the value it refused to write",
      );
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("trap 4, end to end — an APPROVED op is still stopped by a live gate", () => {
  /**
   * The gap I flagged when the gate landed: trap 4 was asserted (`policyRefuses` returns null for
   * an approval, and the reason says so) but never proven against a real gate. "Policy narrows and
   * never grants" is only meaningful if something still stops an approved op.
   *
   * Read-only is that gate. Finding it required fixing it first: measured with `KIT_ELEVATED=1`
   * satisfying elevation, `KIT_READ_ONLY=1 kit secrets propagate ... --to vercel` reached
   * `spawn vercel` and failed only because the CLI is absent from this machine. Propagation writes a
   * secret into a third-party control plane and nothing was refusing it — `read-only-surface.ts`
   * omits `secrets` because it is "already refused inside their own modules", which was true of the
   * LOCAL secret write and false of this one.
   */
  const READ_ONLY_ENV = "KIT_READ_ONLY";

  async function withReadOnly<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env[READ_ONLY_ENV];
    process.env[READ_ONLY_ENV] = "1";
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env[READ_ONLY_ENV];
      else process.env[READ_ONLY_ENV] = prev;
    }
  }

  it("policy approves, read-only refuses anyway — the adapter is never reached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-policy-ro-"));
    try {
      // The op IS pre-approved. If policy granted anything, this would proceed.
      const policy: PolicyConfig = { agent_writes: { vercel: ["env_set"] } };
      assert.equal(
        policyDecision(policy, "vercel", "env_set").state,
        "approved",
        "precondition: the op must be policy-approved for this test to mean anything",
      );

      const results = await withReadOnly(() =>
        propagate("API_KEY", "s3cret", ["vercel"], { policy, cwd: dir }),
      );

      assert.equal(results[0]!.ok, false, "an approved op must still be refused under read-only");
      assert.match(results[0]!.detail, /read-only mode active/);
      // The discriminator: a spawn failure would say ENOENT / "exit 127". Reaching the adapter at
      // all is the failure this test exists to catch.
      assert.doesNotMatch(
        results[0]!.detail,
        /ENOENT|exit 1/,
        "the vendor CLI must not be spawned",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the read-only refusal is audited, in the governed project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-policy-ro-audit-"));
    try {
      await withReadOnly(() =>
        propagate("API_KEY", "s3cret", ["vercel"], {
          policy: { agent_writes: { vercel: ["env_set"] } },
          cwd: dir,
        }),
      );
      const f = join(dir, ".kit-audit.jsonl");
      assert.equal(existsSync(f), true, "a refused write must leave a record");
      const rows = readFileSync(f, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const refusal = rows.find((r) => r.operation === "read-only-mode-refusal");
      assert.ok(refusal, `expected a read-only-mode-refusal entry, got: ${JSON.stringify(rows)}`);
      assert.equal(
        (refusal.metadata as Record<string, unknown>).refused_operation,
        "secrets-propagate",
      );
      assert.doesNotMatch(JSON.stringify(rows), /s3cret/, "the refused value must not be recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read-only refuses BEFORE the policy is consulted — the coarser lock wins", async () => {
    // Ordering matters for the operator's mental model: under a session-wide lock-down the answer
    // should be "read-only", not "your policy is missing an entry". So no policy-check entry.
    const dir = mkdtempSync(join(tmpdir(), "kit-policy-ro-order-"));
    try {
      await withReadOnly(() =>
        propagate("API_KEY", "s3cret", ["vercel"], {
          policy: { agent_writes: { vercel: [] } }, // would ALSO be denied by policy
          cwd: dir,
        }),
      );
      const f = join(dir, ".kit-audit.jsonl");
      const rows = existsSync(f)
        ? readFileSync(f, "utf-8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [];
      assert.equal(
        rows.filter((r) => r.operation === "policy-check").length,
        0,
        "read-only short-circuits, so the policy gate should not also file a decision",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
