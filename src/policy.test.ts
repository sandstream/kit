import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  hashPolicy,
  installPolicyHash,
  currentPolicyHash,
  checkPolicy,
  _resetPolicyHashForTests,
} from "./policy.js";

describe("hashPolicy", () => {
  it("returns null for undefined policy", () => {
    assert.equal(hashPolicy(undefined), null);
  });

  it("returns null for empty policy object", () => {
    // Empty object still hashes (different from null) — explicit non-null.
    const h = hashPolicy({});
    assert.equal(typeof h, "string");
    assert.equal(h?.length, 64);
  });

  it("is stable across key reordering (canonical JSON)", () => {
    const a = hashPolicy({
      agent_writes: {
        sentry: ["resolve_issue", "create_release"],
        supabase: ["rotate_jwt"],
      },
    });
    const b = hashPolicy({
      agent_writes: {
        supabase: ["rotate_jwt"],
        sentry: ["resolve_issue", "create_release"],
      },
    });
    assert.equal(a, b);
  });

  it("changes when any value changes", () => {
    const a = hashPolicy({ agent_writes: { sentry: ["resolve_issue"] } });
    const b = hashPolicy({
      agent_writes: { sentry: ["resolve_issue", "create_release"] },
    });
    assert.notEqual(a, b);
  });
});

describe("installPolicyHash / currentPolicyHash", () => {
  afterEach(() => _resetPolicyHashForTests());

  it("sets KIT_POLICY_HASH when policy is non-null", () => {
    _resetPolicyHashForTests();
    installPolicyHash({ agent_writes: { sentry: ["resolve_issue"] } });
    const hash = currentPolicyHash();
    assert.equal(typeof hash, "string");
    assert.equal(hash?.length, 64);
  });

  it("clears KIT_POLICY_HASH when policy is undefined", () => {
    process.env.KIT_POLICY_HASH = "old";
    installPolicyHash(undefined);
    assert.equal(currentPolicyHash(), null);
  });
});

describe("checkPolicy", () => {
  it("denies when policy missing", async () => {
    const r = await checkPolicy(undefined, "sentry", "resolve_issue");
    assert.equal(r.approved, false);
    assert.match(r.reason, /no \[policy\.agent_writes\] declared/);
  });

  it("denies when vendor not in agent_writes", async () => {
    const r = await checkPolicy(
      { agent_writes: { stripe: ["webhook_create"] } },
      "sentry",
      "resolve_issue",
    );
    assert.equal(r.approved, false);
    assert.match(r.reason, /vendor "sentry" not in/);
  });

  it("denies when op not in vendor's allow-list", async () => {
    const r = await checkPolicy(
      { agent_writes: { sentry: ["create_release"] } },
      "sentry",
      "resolve_issue",
    );
    assert.equal(r.approved, false);
    assert.match(r.reason, /op "resolve_issue" not in/);
  });

  it("approves when vendor + op match the allow-list", async () => {
    const r = await checkPolicy(
      { agent_writes: { sentry: ["resolve_issue", "create_release"] } },
      "sentry",
      "resolve_issue",
    );
    assert.equal(r.approved, true);
    assert.match(r.reason, /approved by/);
  });

  it("denies with empty allow-list (vendor declared but no ops)", async () => {
    const r = await checkPolicy({ agent_writes: { stripe: [] } }, "stripe", "webhook_create");
    assert.equal(r.approved, false);
    assert.match(r.reason, /not in \[policy\.agent_writes\.stripe\]/);
  });

  it("returns policyHash for audit-correlation", async () => {
    const policy = { agent_writes: { sentry: ["resolve_issue"] } };
    const r = await checkPolicy(policy, "sentry", "resolve_issue");
    assert.equal(typeof r.policyHash, "string");
    assert.equal(r.policyHash, hashPolicy(policy));
  });
});
