import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mergeGovernanceConfig,
  checkOperationAllowed,
  isDestructiveOperation,
  detectEnvironmentFromBranch,
} from "./governance.js";

// The governance decision path had no tests. `checkOperationAllowed` IS the
// authorization verdict, so these pin the security-relevant edges — the fail-open
// switch, the fail-closed default, and the approval asymmetry between write and delete.

const base = mergeGovernanceConfig();

function withAccess(
  environment: "dev" | "staging" | "prod",
  access: Record<string, { read: boolean; write: boolean; delete: boolean }>,
  approvalProdWrites = true,
) {
  return mergeGovernanceConfig({
    enabled: true,
    environment,
    access,
    approval: { ...base.approval, production_writes: approvalProdWrites },
  } as Parameters<typeof mergeGovernanceConfig>[0]);
}

describe("checkOperationAllowed", () => {
  it("allows everything when governance is disabled — the bypass, pinned on purpose", () => {
    // If this ever stops being an unconditional allow, every caller's expectations
    // change. It is the one intentional fail-open in the path.
    const off = mergeGovernanceConfig({ enabled: false } as never);
    for (const op of ["read", "write", "delete"] as const) {
      assert.deepEqual(checkOperationAllowed(off, op), { allowed: true }, op);
    }
  });

  it("DENIES when the environment has no access configuration — fail closed", () => {
    // The important one: an environment with no entry must not fall through to allow.
    // Note the config is built DIRECTLY, not through mergeGovernanceConfig: the merge
    // always spreads the defaults over `access`, so dev/staging/prod are present no
    // matter what the user wrote. This branch is therefore only reachable by a caller
    // that assembles the config itself — which is exactly why it is worth pinning.
    const cfg = { ...base, enabled: true, environment: "prod", access: {} } as typeof base;
    const r = checkOperationAllowed(cfg, "read");
    assert.equal(r.allowed, false);
    assert.match(r.reason!, /No access configuration/);
  });

  it("mergeGovernanceConfig always supplies all three environments", () => {
    // The reason the branch above is unreachable through the normal path — stated so a
    // future change to the merge does not silently open a hole.
    const merged = mergeGovernanceConfig({
      access: { dev: { read: true, write: true, delete: true } },
    } as never);
    assert.deepEqual(Object.keys(merged.access).sort(), ["dev", "prod", "staging"]);
  });

  it("denies a read the environment does not permit", () => {
    const cfg = withAccess("prod", { prod: { read: false, write: false, delete: false } });
    const r = checkOperationAllowed(cfg, "read");
    assert.equal(r.allowed, false);
    assert.match(r.reason!, /Read operations not allowed in prod/);
    assert.equal(r.requiresApproval, undefined, "a denied read offers no approval path");
  });

  it("routes a denied prod write to approval when production_writes is on", () => {
    const cfg = withAccess("prod", { prod: { read: true, write: false, delete: false } }, true);
    const r = checkOperationAllowed(cfg, "write");
    assert.equal(r.allowed, false);
    assert.equal(r.requiresApproval, true);
    assert.match(r.reason!, /require approval/);
  });

  it("denies a prod write outright when production_writes is off — no approval path", () => {
    const cfg = withAccess("prod", { prod: { read: true, write: false, delete: false } }, false);
    const r = checkOperationAllowed(cfg, "write");
    assert.equal(r.allowed, false);
    assert.equal(r.requiresApproval, undefined);
  });

  it("does not offer approval for a denied write outside prod", () => {
    // The approval escape hatch is prod-only by design; a staging deny is just a deny.
    const cfg = withAccess("staging", {
      staging: { read: true, write: false, delete: false },
    });
    const r = checkOperationAllowed(cfg, "write");
    assert.equal(r.allowed, false);
    assert.equal(r.requiresApproval, undefined);
  });

  it("always offers approval for a denied delete, in any environment", () => {
    // Asymmetric with write on purpose: delete is never a flat no, it is escalatable.
    for (const env of ["dev", "staging", "prod"] as const) {
      const cfg = withAccess(env, { [env]: { read: true, write: true, delete: false } });
      const r = checkOperationAllowed(cfg, "delete");
      assert.equal(r.allowed, false, env);
      assert.equal(r.requiresApproval, true, env);
    }
  });

  it("allows an operation the environment permits", () => {
    const cfg = withAccess("dev", { dev: { read: true, write: true, delete: true } });
    for (const op of ["read", "write", "delete"] as const) {
      assert.deepEqual(checkOperationAllowed(cfg, op), { allowed: true }, op);
    }
  });
});

describe("isDestructiveOperation", () => {
  it("matches the default keywords case-insensitively", () => {
    for (const cmd of ["DROP TABLE users", "rm -rf /", "truncate logs", "DESTROY everything"]) {
      const expected = /drop|truncate|destroy|delete|remove/i.test(cmd);
      assert.equal(isDestructiveOperation(base, cmd), expected, cmd);
    }
  });

  it("matches a keyword anywhere in the command, not just at the start", () => {
    assert.equal(isDestructiveOperation(base, "psql -c 'drop schema public'"), true);
  });

  it("is a SUBSTRING match, so it over-matches rather than under-matches", () => {
    // `undelete` contains `delete`. Pinned deliberately: a conservative false positive
    // asks for approval on a safe command, which is the right direction for a
    // destructive-operation gate. Anyone tightening this must decide that consciously.
    assert.equal(isDestructiveOperation(base, "undelete the row"), true);
    // But it is a plain substring, not a stem: "removal" does NOT contain "remove", so
    // the over-matching has limits and this is not a word-aware matcher either way.
    assert.equal(isDestructiveOperation(base, "removal notice"), false);
    assert.equal(isDestructiveOperation(base, "remove it"), true);
  });

  it("returns false for a command with no keyword", () => {
    assert.equal(isDestructiveOperation(base, "SELECT * FROM users"), false);
    assert.equal(isDestructiveOperation(base, ""), false);
  });

  it("returns false when the keyword list is empty rather than matching everything", () => {
    const cfg = mergeGovernanceConfig({
      approval: { ...base.approval, destructive_operations: [] },
    } as never);
    assert.equal(isDestructiveOperation(cfg, "drop table users"), false);
  });
});

describe("detectEnvironmentFromBranch", () => {
  it("maps the production branch names to prod", () => {
    for (const b of ["main", "master", "prod", "production"]) {
      assert.equal(detectEnvironmentFromBranch(b), "prod", b);
    }
  });

  it("is case-insensitive", () => {
    assert.equal(detectEnvironmentFromBranch("MAIN"), "prod");
    assert.equal(detectEnvironmentFromBranch("Production"), "prod");
    assert.equal(detectEnvironmentFromBranch("Release/1.2"), "staging");
  });

  it("requires an EXACT match for prod — a similarly-named branch is not production", () => {
    // A prefix match here would classify `mainline` or `master-notes` as prod and apply
    // production restrictions to a feature branch.
    for (const b of ["mainline", "master-notes", "prod-experiment", "not-main"]) {
      assert.equal(detectEnvironmentFromBranch(b), "dev", b);
    }
  });

  it("maps staging names and the release/ prefix to staging", () => {
    for (const b of ["staging", "stage", "release/1.0", "release/hotfix"]) {
      assert.equal(detectEnvironmentFromBranch(b), "staging", b);
    }
  });

  it("treats a bare `release` with no slash as dev", () => {
    assert.equal(detectEnvironmentFromBranch("release"), "dev");
  });

  it("falls back to dev for anything else, including an empty branch name", () => {
    for (const b of ["feature/x", "claude/some-branch", "", "HEAD"]) {
      assert.equal(detectEnvironmentFromBranch(b), "dev", JSON.stringify(b));
    }
  });
});

describe("mergeGovernanceConfig", () => {
  it("returns the defaults when given nothing", () => {
    const d = mergeGovernanceConfig();
    assert.equal(d.enabled, mergeGovernanceConfig(undefined).enabled);
    assert.deepEqual(d.approval.destructive_operations, [
      "delete",
      "drop",
      "truncate",
      "destroy",
      "remove",
    ]);
  });

  it("keeps a default the user did not override", () => {
    const merged = mergeGovernanceConfig({ enabled: true } as never);
    assert.equal(merged.audit.enabled, true);
    assert.equal(merged.approval.approval_timeout, 3600);
  });

  it("replaces a whole environment entry rather than deep-merging it", () => {
    // The nested spread is one level deep: supplying `access.prod` replaces the default
    // prod entry entirely. Pinned because it is a real footgun — a user who sets only
    // `read` for prod gets `write`/`delete` as undefined, not the defaults.
    const merged = mergeGovernanceConfig({
      access: { prod: { read: true } },
    } as never);
    assert.equal(merged.access.prod!.read, true);
    assert.equal(merged.access.prod!.write, undefined);
  });

  it("a replaced entry with undefined write is treated as deny by the decision path", () => {
    // The consequence of the footgun above, stated as behaviour: undefined is falsy, so
    // the gate denies. Over-restrictive, not permissive — the safe direction.
    const merged = mergeGovernanceConfig({
      enabled: true,
      environment: "prod",
      access: { prod: { read: true } },
    } as never);
    assert.equal(checkOperationAllowed(merged, "read").allowed, true);
    assert.equal(checkOperationAllowed(merged, "write").allowed, false);
  });
});
