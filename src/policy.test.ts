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

  it("denies a prototype-member vendor name (own-property guard)", async () => {
    // `toString`/`constructor` resolve to Object.prototype members — a truthy function that
    // could slip past the deny or throw in the authz path. Only an OWN rule counts.
    for (const vendor of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const r = await checkPolicy({ agent_writes: { sentry: ["resolve_issue"] } }, vendor, "x");
      assert.equal(r.approved, false, vendor);
      assert.match(r.reason, /not in \[policy\.agent_writes\]/);
    }
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

describe("currentPolicyHash", () => {
  /**
   * Runs `fn` with KIT_POLICY_HASH restored afterwards. Each case owns the env
   * var outright, so a failure mid-test cannot leak a hash into later tests.
   */
  function withEnv(fn: () => void): void {
    const saved = process.env.KIT_POLICY_HASH;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.KIT_POLICY_HASH;
      else process.env.KIT_POLICY_HASH = saved;
    }
  }

  it("returns null when KIT_POLICY_HASH is absent", () => {
    withEnv(() => {
      _resetPolicyHashForTests();
      // Absent policy must read as null, not undefined: callers compare against
      // `null` to decide "no operator-declared scope exists".
      assert.equal(currentPolicyHash(), null);
    });
  });

  it("round-trips the hash that installPolicyHash exported", () => {
    withEnv(() => {
      _resetPolicyHashForTests();
      const policy = { agent_writes: { sentry: ["resolve_issue"] } };
      installPolicyHash(policy);
      // The env-exported identity must equal the directly computed one, or a
      // child process would disagree with its parent about which policy is live.
      assert.equal(currentPolicyHash(), hashPolicy(policy));
    });
  });

  it("reflects a re-install after the policy changes", () => {
    withEnv(() => {
      _resetPolicyHashForTests();
      installPolicyHash({ agent_writes: { sentry: ["resolve_issue"] } });
      const first = currentPolicyHash();
      installPolicyHash({ agent_writes: { sentry: ["resolve_issue", "create_release"] } });
      const second = currentPolicyHash();
      assert.notEqual(first, second);
      assert.equal(second?.length, 64);
    });
  });

  it("returns null again after installPolicyHash(undefined) clears the scope", () => {
    withEnv(() => {
      installPolicyHash({ agent_writes: { sentry: ["resolve_issue"] } });
      assert.notEqual(currentPolicyHash(), null);
      installPolicyHash(undefined);
      // Losing the policy must revoke the identity rather than leave the previous
      // hash standing — a stale hash would vouch for a scope no longer declared.
      assert.equal(currentPolicyHash(), null);
    });
  });

  it("reads process.env live rather than caching the boot-time value", () => {
    withEnv(() => {
      _resetPolicyHashForTests();
      installPolicyHash({ agent_writes: { sentry: ["resolve_issue"] } });
      const installed = currentPolicyHash();
      delete process.env.KIT_POLICY_HASH;
      // No memoization: if the value were cached at first read, a cleared env
      // would still report the old hash.
      assert.equal(currentPolicyHash(), null);
      process.env.KIT_POLICY_HASH = installed as string;
      assert.equal(currentPolicyHash(), installed);
    });
  });

  it("returns an inherited env value verbatim without validating it", () => {
    withEnv(() => {
      // ACTUAL behaviour: the getter is a raw env read — it does not check length,
      // hex-ness, or that installPolicyHash produced the value. Documented here so a
      // future change to trust-on-read is a deliberate, test-breaking decision.
      process.env.KIT_POLICY_HASH = "not-a-sha256";
      assert.equal(currentPolicyHash(), "not-a-sha256");
      process.env.KIT_POLICY_HASH = "  0123abc  ";
      // Whitespace is not trimmed either.
      assert.equal(currentPolicyHash(), "  0123abc  ");
    });
  });

  it("returns an empty string (not null) when KIT_POLICY_HASH is set but empty", () => {
    withEnv(() => {
      process.env.KIT_POLICY_HASH = "";
      // `?? null` only catches null/undefined, so an empty assignment survives as "".
      // Callers testing `=== null` see "a policy hash exists"; callers testing
      // truthiness see "none". That divergence is the boundary worth pinning.
      assert.equal(currentPolicyHash(), "");
      assert.notEqual(currentPolicyHash(), null);
    });
  });

  it("is unaffected by checkPolicy — checking a policy does not install its hash", async () => {
    const saved = process.env.KIT_POLICY_HASH;
    try {
      _resetPolicyHashForTests();
      const r = await checkPolicy(
        { agent_writes: { sentry: ["resolve_issue"] } },
        "sentry",
        "resolve_issue",
      );
      assert.equal(r.approved, true);
      // checkPolicy computes its own hash for the audit record; only
      // installPolicyHash may publish one to the environment. If checking ever
      // started exporting, an out-of-scope check could redefine the live identity.
      assert.equal(currentPolicyHash(), null);
    } finally {
      if (saved === undefined) delete process.env.KIT_POLICY_HASH;
      else process.env.KIT_POLICY_HASH = saved;
    }
  });
});
