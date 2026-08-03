import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rbacPolicyRoot } from "./resolve.js";

// `rbacPolicyRoot` picks the directory every RBAC decision is loaded from, so its
// precedence IS a trust decision: whoever controls `KIT_RBAC_POLICY` controls which
// signed policy is consulted. These cases pin the precedence, the `??`-vs-`||`
// semantics (an EMPTY env value is honoured, not skipped), and the fact that the
// returned string is passed through with no normalization.

describe("rbacPolicyRoot", () => {
  const prevEnv = process.env.KIT_RBAC_POLICY;
  after(() => {
    if (prevEnv === undefined) delete process.env.KIT_RBAC_POLICY;
    else process.env.KIT_RBAC_POLICY = prevEnv;
  });

  /** Run `fn` with KIT_RBAC_POLICY set to `value` (or removed when undefined). */
  function withEnv<T>(value: string | undefined, fn: () => T): T {
    const before = process.env.KIT_RBAC_POLICY;
    if (value === undefined) delete process.env.KIT_RBAC_POLICY;
    else process.env.KIT_RBAC_POLICY = value;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.KIT_RBAC_POLICY;
      else process.env.KIT_RBAC_POLICY = before;
    }
  }

  it("returns the explicit override when the env var is unset", () => {
    withEnv(undefined, () => {
      assert.equal(rbacPolicyRoot("/explicit/root"), "/explicit/root");
    });
  });

  it("returns the cwd when there is neither an env var nor an override", () => {
    withEnv(undefined, () => {
      assert.equal(rbacPolicyRoot(), process.cwd());
      // An explicitly-passed `undefined` must behave exactly like no argument —
      // callers forward an optional flag value straight through.
      assert.equal(rbacPolicyRoot(undefined), process.cwd());
    });
  });

  it("lets the env var win over an explicit override", () => {
    // Precedence direction matters for the threat model: the ENVIRONMENT outranks the
    // caller's argument, so an attacker with env control can redirect policy loading
    // even when the caller passed a root. Flipping this order would be a behaviour
    // change every call site depends on.
    withEnv("/env/root", () => {
      assert.equal(rbacPolicyRoot("/explicit/root"), "/env/root");
      assert.equal(rbacPolicyRoot(), "/env/root");
    });
  });

  it("honours an EMPTY env var instead of falling through to the override or cwd", () => {
    // `??` only skips null/undefined, so `KIT_RBAC_POLICY=` (a bare `export` in a
    // shell, or a CI variable defined-but-blank) yields "" — NOT the override and NOT
    // the cwd. Downstream that means policy files are looked up relative to "", i.e.
    // no policy is found and RBAC fails closed. Asserted as the actual behaviour;
    // see notes — treating "" as absent would be the safer reading.
    withEnv("", () => {
      assert.equal(rbacPolicyRoot("/explicit/root"), "");
      assert.equal(rbacPolicyRoot(), "");
    });
  });

  it("honours an empty-string override instead of falling through to cwd", () => {
    // Same `??` semantics one level down: an empty override is a value, not an absence.
    withEnv(undefined, () => {
      assert.equal(rbacPolicyRoot(""), "");
    });
  });

  it("reads the env var at call time, not once at import", () => {
    // Policy root has to be re-read per call: kit's own tests and long-lived processes
    // (MCP server, watch loops) change the variable between decisions. Caching it at
    // module load would silently pin the first value seen.
    withEnv(undefined, () => {
      assert.equal(rbacPolicyRoot("/a"), "/a");
      process.env.KIT_RBAC_POLICY = "/first";
      assert.equal(rbacPolicyRoot("/a"), "/first");
      process.env.KIT_RBAC_POLICY = "/second";
      assert.equal(rbacPolicyRoot("/a"), "/second");
      delete process.env.KIT_RBAC_POLICY;
      assert.equal(rbacPolicyRoot("/a"), "/a");
    });
  });

  it("returns the value verbatim — no resolution, normalization or trimming", () => {
    // The result is NOT sanitized here, so callers must not assume an absolute or
    // normalized path. Pinned so nobody adds a silent `resolve()`/`trim()` (which
    // would change which directory a policy is read from) without updating callers.
    withEnv(undefined, () => {
      for (const raw of [
        "relative/dir",
        "../../etc",
        "/abs//double/slash/",
        "~/kit",
        "  /padded/root  ",
        "/root\nwith-newline",
      ]) {
        assert.equal(rbacPolicyRoot(raw), raw, `override must pass through: ${raw}`);
      }
    });
    withEnv("../../etc", () => {
      // Same for the env path — traversal is neither rejected nor collapsed.
      assert.equal(rbacPolicyRoot(), "../../etc");
    });
  });

  it("tracks the process cwd rather than a snapshot of it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-rbac-root-"));
    const origin = process.cwd();
    try {
      withEnv(undefined, () => {
        process.chdir(dir);
        // realpath because the OS temp dir can itself be a symlink, while cwd is real.
        assert.equal(rbacPolicyRoot(), realpathSync(dir));
        assert.notEqual(rbacPolicyRoot(), origin);
      });
    } finally {
      process.chdir(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
