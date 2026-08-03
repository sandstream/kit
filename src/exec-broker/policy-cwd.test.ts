// The unsigned broker policy must be resolved from the GOVERNED project's directory, not from
// the calling process's. `runBrokered` has always taken a `cwd` — `brokerExec` measures fs
// writes against it and `audit` files evidence under it — but path 2 (`.kit-exec-broker.json`)
// resolved the file against `process.cwd()`, so a long-lived process mediating another tree
// (the MCP server: `kit_secrets`, `kit_run`, `kit_triage` all pass a per-call `cwd`) read the
// wrong policy, or none.
//
// EVERY test here is two-sided. Per ROADMAP: "a test that merely passes `cwd` proves nothing".
// So each one is paired with its mirror image — the same call with the file in the other tree —
// and asserts the OUTCOMES DIFFER. A build that ignores `cwd` makes the two sides agree and
// fails the pair, which is the only way this stays fixed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { brokerPolicyPath, loadBrokerPolicy, BROKER_POLICY_ENV } from "./policy.js";
import { runBrokered } from "./broker.js";

/** A valid policy whose write-root is `<dir>/allowed` and nothing else. */
function policyAllowingOnly(dir: string): string {
  return JSON.stringify({
    egress: { allow: [] },
    fs: { root: join(dir, "allowed") },
    env: { declared: [] },
  });
}

/** Two sibling temp dirs: A = the process's cwd, B = the governed project. */
function twoProjects(): { base: string; A: string; B: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "broker-cwd-"));
  const A = join(base, "A");
  const B = join(base, "B");
  mkdirSync(A);
  mkdirSync(B);
  return { base, A, B, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Run `fn` with cwd = `dir` and the env override cleared, restoring both afterwards. */
async function inCwd<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const prevCwd = process.cwd();
  const prevEnv = process.env[BROKER_POLICY_ENV];
  delete process.env[BROKER_POLICY_ENV];
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env[BROKER_POLICY_ENV];
    else process.env[BROKER_POLICY_ENV] = prevEnv;
  }
}

test("broker policy resolves from the governed project's cwd, not process.cwd()", async (t) => {
  await t.test("brokerPolicyPath: the two trees yield DIFFERENT paths", async () => {
    const { A, B, cleanup } = twoProjects();
    try {
      await inCwd(A, () => {
        const fromProcess = brokerPolicyPath();
        const fromGoverned = brokerPolicyPath(undefined, B);
        // The pair, not either alone: if `cwd` were ignored these would be equal.
        assert.notEqual(fromGoverned, fromProcess);
        assert.equal(fromGoverned, resolve(B, ".kit-exec-broker.json"));
        assert.equal(fromProcess, resolve(A, ".kit-exec-broker.json"));
      });
    } finally {
      cleanup();
    }
  });

  await t.test("brokerPolicyPath: an explicit override still outranks cwd", async () => {
    const { A, B, cleanup } = twoProjects();
    try {
      await inCwd(A, () => {
        assert.equal(brokerPolicyPath(join(B, "explicit.json"), A), resolve(B, "explicit.json"));
      });
    } finally {
      cleanup();
    }
  });

  await t.test("brokerPolicyPath: KIT_EXEC_BROKER_POLICY still outranks cwd", async () => {
    const { A, B, cleanup } = twoProjects();
    try {
      const prevCwd = process.cwd();
      const prevEnv = process.env[BROKER_POLICY_ENV];
      process.chdir(A);
      process.env[BROKER_POLICY_ENV] = join(B, "from-env.json");
      try {
        assert.equal(brokerPolicyPath(undefined, A), resolve(B, "from-env.json"));
      } finally {
        process.chdir(prevCwd);
        if (prevEnv === undefined) delete process.env[BROKER_POLICY_ENV];
        else process.env[BROKER_POLICY_ENV] = prevEnv;
      }
    } finally {
      cleanup();
    }
  });

  await t.test("loadBrokerPolicy: reads B's file and NOT A's", async () => {
    const { A, B, cleanup } = twoProjects();
    try {
      writeFileSync(join(A, ".kit-exec-broker.json"), policyAllowingOnly(A));
      writeFileSync(join(B, ".kit-exec-broker.json"), policyAllowingOnly(B));
      await inCwd(A, () => {
        const governed = loadBrokerPolicy(undefined, B);
        const process_ = loadBrokerPolicy();
        assert.equal(governed?.fs.root, join(B, "allowed"));
        assert.equal(process_?.fs.root, join(A, "allowed"));
        assert.notEqual(governed?.fs.root, process_?.fs.root);
      });
    } finally {
      cleanup();
    }
  });

  await t.test("loadBrokerPolicy: B has no file → null even though A does", async () => {
    const { A, B, cleanup } = twoProjects();
    try {
      writeFileSync(join(A, ".kit-exec-broker.json"), policyAllowingOnly(A));
      await inCwd(A, () => {
        // Ignoring `cwd` would return A's policy here — a policy for the wrong tree.
        assert.equal(loadBrokerPolicy(undefined, B), null);
        assert.notEqual(loadBrokerPolicy(), null);
      });
    } finally {
      cleanup();
    }
  });

  // The regression that motivated the change: measured end-to-end, both directions.
  await t.test("runBrokered: B's policy DENIES a write outside its own root", async () => {
    const { A, B, cleanup } = twoProjects();
    try {
      writeFileSync(join(B, ".kit-exec-broker.json"), policyAllowingOnly(B));
      // A deliberately has NO policy: before the fix this made path 2 read "not configured"
      // and run the operation unmediated with full env, ignoring B's policy entirely.
      let ran = false;
      const out = await inCwd(A, () =>
        runBrokered(
          {
            operation: "probe.write",
            operationType: "write",
            metadata: {},
            fsWrites: [join(B, "outside-the-root.txt")],
          },
          async () => {
            ran = true;
            return "executed";
          },
          { cwd: B },
        ),
      );
      assert.equal(out.ok, false, "a write outside B's declared root must be denied");
      assert.equal(ran, false, "the operation must never have run");
    } finally {
      cleanup();
    }
  });

  await t.test("runBrokered: B's policy ALLOWS a write inside its own root", async () => {
    const { A, B, cleanup } = twoProjects();
    try {
      mkdirSync(join(B, "allowed"));
      writeFileSync(join(B, ".kit-exec-broker.json"), policyAllowingOnly(B));
      let ran = false;
      const out = await inCwd(A, () =>
        runBrokered(
          {
            operation: "probe.write",
            operationType: "write",
            metadata: {},
            fsWrites: [join(B, "allowed", "inside.txt")],
          },
          async () => {
            ran = true;
            return "executed";
          },
          { cwd: B },
        ),
      );
      // The mirror of the test above: same policy, same governed tree, different target.
      // Both directions are needed — a guard that denies everything would pass the first.
      assert.equal(out.ok, true, out.ok ? "" : `unexpectedly denied: ${out.reason}`);
      assert.equal(ran, true, "the operation must have run");
    } finally {
      cleanup();
    }
  });

  await t.test(
    "runBrokered: a brokered process refuses a foreign tree with no policy",
    async () => {
      const { A, B, cleanup } = twoProjects();
      try {
        // A (this process) is brokered; B is not. Absence of a policy is only an opt-out for
        // the tree the process lives in — for a foreign tree it is unknown, so: deny.
        writeFileSync(join(A, ".kit-exec-broker.json"), policyAllowingOnly(A));
        let ran = false;
        const out = await inCwd(A, () =>
          runBrokered(
            {
              operation: "probe.write",
              operationType: "write",
              metadata: {},
              fsWrites: [join(B, "file.txt")],
            },
            async () => {
              ran = true;
              return "executed";
            },
            { cwd: B },
          ),
        );
        assert.equal(out.ok, false);
        assert.equal(ran, false);
        assert.match(String(out.reason), /governed project/);
      } finally {
        cleanup();
      }
    },
  );

  await t.test("runBrokered: an UNBROKERED process still passes through, unchanged", async () => {
    const { A, B, cleanup } = twoProjects();
    try {
      // Neither tree has a policy — the ordinary case for everyone who has not opted in.
      // This must behave exactly as before the change, or the fix is a silent breaking change.
      let ran = false;
      const out = await inCwd(A, () =>
        runBrokered(
          {
            operation: "probe.write",
            operationType: "write",
            metadata: {},
            fsWrites: [join(B, "file.txt")],
          },
          async () => {
            ran = true;
            return "executed";
          },
          { cwd: B },
        ),
      );
      assert.equal(out.ok, true, out.ok ? "" : `unexpectedly denied: ${out.reason}`);
      assert.equal(ran, true);
    } finally {
      cleanup();
    }
  });

  await t.test("runBrokered: omitting cwd is identical to passing process.cwd()", async () => {
    const { A, cleanup } = twoProjects();
    try {
      writeFileSync(join(A, ".kit-exec-broker.json"), policyAllowingOnly(A));
      mkdirSync(join(A, "allowed"));
      const call = (cwd?: string): Promise<{ ok: boolean }> =>
        inCwd(A, () =>
          runBrokered(
            {
              operation: "probe.write",
              operationType: "write",
              metadata: {},
              fsWrites: [join(A, "allowed", "x.txt")],
            },
            async () => "executed",
            cwd === undefined ? {} : { cwd },
          ),
        );
      const omitted = await call();
      const explicit = await call(A);
      // The no-op guarantee in the docstring, asserted rather than asserted-in-prose.
      assert.equal(omitted.ok, true);
      assert.equal(explicit.ok, omitted.ok);
    } finally {
      cleanup();
    }
  });
});
